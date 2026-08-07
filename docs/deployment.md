# デプロイ (Cloudflare Workers Builds)

このアプリの CD は **Cloudflare Workers Builds**（GitHub 連携）で行う。`mpppk/wine` リポジトリに
2 つの Worker が接続されている。

## 環境

| Worker | 用途 | URL | D1 | R2 | Queue |
|---|---|---|---|---|---|
| `wine` | 本番 | https://wine.nibo.sh （カスタムドメイン。https://wine.niboshi.workers.dev でも可） | `wine-db` | `avatars-wine` | `wine-label-jobs` |
| `wine-preview` | プレビュー（PRごと / main のミラー） | `https://<branch>-wine-preview.niboshi.workers.dev`（PR作成後に自動発行。URLはPRコメントに記載） | `wine-preview-db`（プレビュー共通） | `avatars-wine-preview`（プレビュー共通） | `wine-label-jobs-preview`（プレビュー共通） |

- プレビューの D1/R2/Queue は全PRで共有されるため、あるプレビュー環境で作成したデータは他のプレビュー環境からも見える。また PR に含まれるマイグレーションは、マージ前でもプレビュー共通DBへ先行適用される。
- Queue はエチケット解析のジョブ化（#460）で追加した。**producer と consumer は同じ Worker に同居**しており（`src/worker.ts` が `fetch` と `queue` の両方を export する）、別 Worker は立てていない。キュー自体は Terraform 管理外なので、環境を作り直すときは `wrangler queues create <name>` で先に作る（存在しないキューを参照するとデプロイが失敗する）。
- **Web Push の VAPID 鍵**（#466）は本番・プレビューで**同じ鍵ペア**を使う。公開鍵は `wrangler.jsonc` の `vars.VAPID_PUBLIC_KEY`（そもそもブラウザまで届く公開情報）、秘密鍵は `wrangler secret put VAPID_PRIVATE_KEY`（プレビューは `--env preview`）。購読は origin ごとに別なので、鍵を共有しても本番とプレビューの通知が混ざることはない。鍵ペアは `node scripts/generate-vapid-keys.mjs` で作る。**入れ替えると既存の購読は全て無効になる**ので、入れ替えたら `push_subscription` を空にして購読し直してもらう。
- **PRごとのプレビューURLではキュー・コンシューマが動かない**（#460 で実測）。ブランチプレビューの deploy command は `wrangler versions upload` で、これは*バージョン*を上げるだけで*デプロイ*を作らない。producer バインディングは付くのでジョブの投入・予約・状態取得までは動くが、consumer はキューに登録されず（`wrangler queues info wine-label-jobs-preview` が `Number of Consumers: 0` を返す）、投入したジョブは `queued` のまま `LABEL_JOB_QUEUE_STALE_MS` で失敗として決着する。ログが取れないのと同じ制約（CLAUDE.md）で回避策は無い。**キューを跨ぐ経路の実機確認はローカル（`bun run dev`。miniflare が producer/consumer 両方を張る）で行い、デプロイ済み環境での確認はマージ後**（`main` の2トリガーは `wrangler deploy` なので consumer が付く）。
- ログイン等で origin を検証するため、公開ドメインを追加/変更したら `src/lib/auth.ts` の `trustedOrigins` にも登録する（プレビューはダッシュ連結ホスト名 `https://*-wine-preview.niboshi.workers.dev` 用のワイルドカードが別途必要）。

## DB マイグレーションの自動実行

マイグレーションは **各トリガーの deploy command で自動実行**する。ビルド（`bun run build`）が
成功した後・デプロイ直前に走るため、ビルド失敗時は DB に一切触れない。手動で
`bun run db:migrate:remote` / `db:migrate:preview` をデプロイ前に叩く運用は不要。

> deploy command 側に置くのは失敗時の安全性のため。build command 側に置くと、マイグレーション適用後に
> ビルドが失敗した場合、DB だけ進んでデプロイされない状態になり得る。

それでも「適用 → 新 Worker 反映」の間には短い窓が残り、ここでデプロイが失敗すると
**新スキーマ×旧コード**のまま固定化する。この状態は `/` も OAuth メタデータも DB を引かずに 200 を
返すため外形からは分からないので、`/api/health` が**適用済みの最新マイグレーションとコード側が期待する
世代（`src/db/migrations.ts` の `EXPECTED_LATEST_MIGRATION`）を突き合わせて**返す。ズレ・D1 到達不能は
どちらも 503 + `"ok":false` になり、**デプロイ直後のスモーク**（下記）と1時間ごとの定期スモーク
（`.github/workflows/smoke.yml`）が検出する（#336, #396）。
**`drizzle/` に連番SQLを足したら `EXPECTED_LATEST_MIGRATION` も更新する**（テストが強制する）。

### デプロイ直後のスモーク（#396）

deploy command の末尾で `scripts/smoke.sh` を走らせ、**デプロイした Worker 自身を外形から叩いて**
から成功にする。これが無かった頃は、上記の「新スキーマ×旧コード」を含む壊れたデプロイが
次の cron tick（最大6時間後）まで誰にも見えなかった。

- **ロールバックはしない**。`wrangler deploy` は既に完了しているので、これは*検出*であって
  復旧ではない。落ちたときは Workers Builds のビルドが赤くなり（＝通知が飛び）、運用者が
  revert を出すか手で直す
- **ブランチプレビュー（`main` 以外）では走らせない**。`wrangler versions upload` はプレビュー
  URL を差し替えるだけで、そのURLは bot 保護等でCIから到達できないことがある（CLAUDE.md 参照）
- 一過性の 5xx・伝播中の揺らぎは `scripts/smoke.sh` の `curl --retry` が吸収する

### トリガー設定

Workers Builds の build / deploy command はダッシュボード（Settings > Build）にのみ保存され、
`wrangler.jsonc` などリポジトリのファイルには保存できない。現在の設定は以下。

### トリガー設定

Workers Builds の build / deploy command はダッシュボード（Settings > Build）にのみ保存され、
`wrangler.jsonc` などリポジトリのファイルには保存できない。現在の設定は以下。

| Worker | ブランチ | build command | deploy command |
|---|---|---|---|
| `wine` | `main` | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:remote && npx wrangler deploy && bun run smoke` |
| `wine-preview` | `main` | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:preview && npx wrangler deploy && bun run smoke:preview` |
| `wine-preview` | `*`（`main` 以外） | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:preview && npx wrangler versions upload` |

- `db:migrate:remote` = `wrangler d1 migrations apply DB --remote`（`wine-db`）
- `db:migrate:preview` = `wrangler d1 migrations apply DB --remote --env preview`（`wine-preview-db`）
- `smoke` = `bash scripts/smoke.sh`（既定で本番 `https://wine.nibo.sh`）、
  `smoke:preview` = 同スクリプトを `https://wine-preview.niboshi.workers.dev --shared-db` で叩く。
  **URL とオプションを `package.json` 側に置いてある**のは、ダッシュボードにしか保存できない
  deploy command を短く保ち、対象URLの変更をリポジトリで追えるようにするため（#396）
- **bun のバージョンは `package.json` の `packageManager` が真実の源**（#339）。CI（`setup-bun` の
  `bun-version-file: package.json`）とローカル（`bun` 本体が読む）はこれで揃うが、**Workers Builds の
  ビルドイメージはこのフィールドを見ない**。ビルド環境変数 `BUN_VERSION` を同じ値に設定して揃える
  （未設定だとイメージ既定の bun が使われ、更新時に予告なく変わる。
  [build image の既定値と上書き](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/#overriding-default-versions)）。
  設定は下記の Workers Builds API か、ダッシュボードの Settings > Build > Build variables から行う。
  **`packageManager` を上げたら `BUN_VERSION` も同じ値に上げる**（Renovate は前者しか更新しない）。
- **`wine-preview` の2トリガーは `CLOUDFLARE_ENV=preview` が効いていることが前提**。上表の
  build / deploy command 自体には現れないので、ダッシュボードのビルド環境変数として設定されている
  （`wrangler.jsonc` の `env.preview` を選ばせるスイッチで、無いとトップレベル設定＝本番 `wine` を
  指してしまう）。ローカルで同じことをする `package.json` の `deploy:preview` は
  `CLOUDFLARE_ENV=preview vite build && CLOUDFLARE_ENV=preview wrangler versions upload` と
  コマンド内に直接書いており、**表のコマンドだけを手元で再現すると本番 env でビルドされる**点に注意。
  設定場所（コマンド内 / ビルド環境変数）を変えたときは、この節と `package.json` の両方を更新する。
- マイグレーションは冪等（適用済みの連番 SQL はスキップ）なので、プレビュー共通 DB に複数トリガーから
  適用されても問題ない。

### プレビューDBのリセット

プレビュー共通 DB（`wine-preview-db`）は全 PR で共有されるため、次のような場合に本番と履歴が
乖離して壊れることがある（Issue #54）。

- クローズした PR のマイグレーションがロールバックされず残留し、後で `main` に別名・同番号の
  マイグレーションがマージされた。
- スキーマ変更 PR を同時に複数オープンし、同じ連番の別ファイルが両方適用されて相反した
  （`d1 migrations apply` は適用済みを**ファイル名**で記録するため、以後 apply が失敗し続ける）。
- あるブランチの破壊的変更（`DROP TABLE`/`DROP COLUMN` 等）が共有 DB に当たり、それを知らない
  他ブランチのプレビューが実行時エラーになった。

これは本番（`wine-db`）には影響しない。プレビューだけが壊れるので、プレビュー DB を
本番と同じスキーマ履歴で作り直す。

```bash
# 1) 適用状況を確認（何が食い違っているか把握する）
npx wrangler d1 migrations list DB --remote --env preview

# 2) プレビュー DB の全テーブルを削除して初期化する。ダッシュボードの D1 (`wine-preview-db`) で
#    "Reset database" を使うか、以下のように内部テーブルも含めて drop する SQL を流す。
#    （プレビュー共通データは検証用なので消えて問題ない）
npx wrangler d1 execute DB --remote --env preview --command \
  "SELECT 'DROP TABLE IF EXISTS \"' || name || '\";' FROM sqlite_master WHERE type='table';"
#    出力された DROP 文を実行し、d1_migrations テーブルも含めて全削除する。

# 3) main 相当の連番 SQL をゼロから適用し直す（本番と同じ履歴に揃える）
git checkout main -- drizzle/
npx wrangler d1 migrations apply DB --remote --env preview
```

恒久策としては「スキーマ変更 PR を1本ずつマージする」運用を守る（CLAUDE.md 参照）。それでも
残留が問題になるなら、スキーマ変更 PR だけブランチ専用 D1 を割り当てる仕組みを別途検討する。

## 定期スモーク（`.github/workflows/smoke.yml`）

デプロイ直後のスモーク（上記）が拾うのは「デプロイが壊れた」ケースだけで、**デプロイを経由しない
破損**は拾えない。共有プレビュー DB の汚染（上記 #54）、外部サービス側の変化、ドメイン・証明書の
失効などがこれに当たる。そこで1時間ごとに、デプロイ済みの2環境を matrix で叩く（#396）。

| 対象 | URL | プロファイル |
|---|---|---|
| 本番 `wine` | https://wine.nibo.sh | 既定（`/api/health` に `"ok":true` を要求） |
| main ミラー `wine-preview` | https://wine-preview.niboshi.workers.dev | `--shared-db` |

`workflow_dispatch` では任意URL（PRごとのプレビュー等）を対象にできる。共有 D1 を使う対象なら
`shared_db` 入力にチェックを入れる。

### `--shared-db` プロファイル

プレビュー共通 DB には**開いている PR ブランチのマイグレーションが main より先に適用される**
（上記「環境」）。したがって main ミラーでは「適用済み > `EXPECTED_LATEST_MIGRATION`」が**正常**で、
本番と同じ `"ok":true` を要求すると、誰かがスキーマ変更 PR を開いている間ずっとスモークが赤くなる
（＝赤が常態化して誰も見なくなる）。`--shared-db` は `/api/health` の判定だけを次のように緩める。

- 許容: 適用済みが期待より**進んでいる**（503 + `inSync:false` でも通す）
- 検出: `"db":"error"`（D1 到達不能・バインディング設定ミス・共有DB破損）
- 検出: 適用済みが期待より**戻っている**（マイグレーションが当たらず新コードだけ載った状態）

他のチェック（`/`・better-auth・OAuth メタデータ・MCP・GeoJSON）は本番と同一。

## ランタイムログの確認

`wrangler.jsonc` の `observability.enabled: true` により、本番・プレビューとも
**Workers Logs**（Workers Observability）にランタイムログが蓄積される。ダッシュボードに
入れない環境（Claude Code on the web / CI）からは `bun run logs` で検索する。

```bash
bun run logs                             # 本番(wine)の直近1時間
bun run logs --env preview --since 3h    # プレビュー(wine-preview)の直近3時間
bun run logs --level error,warn          # エラー・警告のみ
bun run logs --grep stripe --since 1d    # message の部分一致
bun run logs --version <version-id>      # 特定バージョン(PRのプレビュー)に限定
bun run logs --json                      # 生JSON(jq で加工する場合)
```

- `CLOUDFLARE_API_TOKEN`（Workers Observability の Read 権限を含むこと）が必要。account id は
  自動解決されるが、複数アカウントに属する場合のみ `CLOUDFLARE_ACCOUNT_ID` を指定する。
- `wrangler tail` は「今まさに流れているログ」のみで、再現操作と同時に走らせる必要がある。
  後から追う用途には `bun run logs` を使う。
- 保持期間は最大7日（それ以前を追う必要が出たら Logpush で R2 へ転送する）。

### レートリミットが効いているかの確認

書き込みのスロットル（#397 / `src/lib/rate-limit.ts`）は **Cloudflare Workers の Rate Limiting
バインディング**で判定する。**未設定・判定失敗は「素通し」に倒す**設計なので、効いていなくても
アプリは正常に見える。効いているかは実際に上限を超えて叩いて確かめるしかない。

> 🚨 **2026-08-03 時点で、実環境では機能していないことを実測済み**（原因未特定。#397 は未解決）。
> 下記の手順で 429 が返らない状態が続いている。「設定したから効いているはず」と判断しないこと。

```bash
# 1) デプロイ済みバージョンにバインディングがあるか（設定が届いているかの確認）
npx wrangler deployments list --env preview      # 稼働中の version id を確認
npx wrangler versions view <version-id> --env preview | grep -i "rate limit"

# 2) 実際に上限を超えて叩く（RATE_LIMIT_UPLOAD は 30/60s）。
#    ボディ無し POST なら requireApiSession（=判定）は通り、その後 400 になるので
#    R2 に書き込まずに判定だけを試せる。429 が混ざれば効いている。
for i in $(seq 1 45); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST \
    https://wine-preview.niboshi.workers.dev/api/upload -H "Cookie: <session cookie>"
done

# 3) ログで裏を取る
bun run logs --env preview --grep "rate limited" --since 30m        # 絞られた記録
bun run logs --env preview --grep "rate limit binding" --since 30m  # バインディング未解決の警告
```

**3 の「0 件」は根拠にならない**。同環境では warn レベルのログが出ている実績が乏しく、
「警告が無い＝バインディングが解決している」とは言えない（positive control が取れない）。
判断は **2 のステータスコード**で行う。

### AI 推論の実行記録

AI 経路（エチケット解析・地域 Q&A・写真からの一括抽出）は、**成功・残高不足・失敗の
すべてで実行記録を 1 行出す**。実装は `src/lib/ai/inference-log.ts`（`logAiInference`）で、
`msg` は全経路共通の `ai inference`。

```bash
bun run logs --grep "ai inference" --since 1d          # 全AI経路の実行履歴
bun run logs --grep "ai inference" --level warn        # 失敗のみ
```

| フィールド | 意味 |
|---|---|
| `feature` | `label_analysis` / `region_qa` / `wine_list_analysis` |
| `outcome` | `ok`（確定）/ `blocked`（残高不足で推論せず）/ `failed`（返却済み） |
| `selected` | ユーザ選択（または既定）のエンジン・モデルキー |
| `route` | シークレットの設定状況を加味して**意図した**経路 |
| `executedBy` | **実際に結果を出した**経路。`route` と食い違えばフォールバック |
| `fellBack` | 上記 2 つから導出。`true` なら高精度経路が落ちて拾われた |
| `model` | 実際に呼んだモデル ID（`gpt-5.6-luna` 等） |
| `actualTokens` / `reservedTokens` | 実測と予約。見積の妥当性の評価に使う |
| `requestId` | `credit_ledger.request_id` と同値。台帳と突き合わせられる |
| `webResearch` | 高精度エチケット解析の**検索の軌跡**。下記参照 |
| `fieldSources` | 抽出フィールドごとの**根拠**（モデルの自己申告）。下記参照 |

#### エチケット解析の裏取りを追う

高精度経路（`gpt-luna` / `web-research`）は web 検索で生産者・呼称・品種を裏取りするが、
**何を検索して何を読んだかは応答の外からは一切見えない**。検索結果は毎回変わるので、
後から同じ写真で再実行しても再現しない。推定が外れたときに「写真の読み取りを間違えた」
のか「拾った情報が間違っていた」のかを切り分けられるよう、実行時に拾って 1 行に載せている。

```jsonc
{
  "msg": "ai inference", "feature": "label_analysis", "executedBy": "gpt-luna",
  "webResearch": {
    "steps": [
      { "action": "search", "query": "Trimbach Clos Sainte Hune 2017",
        "urls": ["https://www.trimbach.fr/..."], "urlCount": 8 },
      { "action": "open", "urls": ["https://www.trimbach.fr/..."], "urlCount": 1 }
    ],
    "stepCount": 2,
    "hosts": ["www.trimbach.fr", "www.wine-searcher.com"]
  },
  "fieldSources": {
    "vintage": { "origin": "photo" },
    "grape_varieties": { "origin": "web", "url": "https://www.trimbach.fr/..." }
  }
}
```

- `webResearch.steps[].action` — `search`（検索）/ `open`（ページを開いた）/ `find`（ページ内検索）。
  失敗時は `error`（`max_uses_exceeded` なら上限で裏取りを打ち切ったということ）。
- `steps` は 20 件、`urls` は 1 操作 5 件で打ち切る。総数は `stepCount` / `urlCount` に残るので、
  打ち切られたかどうかは差分で分かる。`hosts` は「どのサイトを見たか」の要約で、
  `bun run logs --grep vivino` のような雑な検索で引っかけるためのもの。
- `fieldSources[].origin` — `photo`（写真から読んだ）/ `web`（検索で補った）/
  `photo_and_web`（写真の読み取りを検索で裏取り・修正した）/ `unknown`（特定できず null）。
  GPT 経路は structured outputs で強制されるので必ず出るが、**Claude 経路はプロンプトでしか
  要求できないので欠けることがある**。
- **推論が失敗してフォールバックした回にも `webResearch` は出る**（応答のパースより先に
  軌跡を取っている）。「検索まで到達したが結果を使えなかった」のか「そもそも検索できな
  かった」のかは、このフィールドが空かどうかで分かる。
- 検索をしない経路（`region_qa` / `wine_list_analysis` / `workers-ai` へのフォールバック）では
  フィールドごと出ない。空の軌跡を出すと「検索したが何も見つからなかった」と誤読されるため。

> [!NOTE]
> **「警告が出ていないこと」を成功の証拠にしない。** 成功経路が無言だった頃は、
> 警告の不在が「正常に動いた」と「そもそも誰も使っていない」のどちらなのか区別できず、
> GPT-5.6 Luna 導入時（#357）の本番確認ではクレジット台帳の `:settle` 行と見積式を
> 突き合わせる間接的な推論に頼るしかなかった。`outcome: "ok"` の行を直接見ること。

> [!CAUTION]
> **`webResearch` / `fieldSources` からは、利用者が解析した銘柄が復元できる。**
> 検索クエリはラベルから読み取った生産者名・ワイン名そのもので、参照 URL も
> Wine-Searcher の銘柄ページのように銘柄を含む。`userId` と同じ行に載るので
> 「誰が何を解析したか」が読める。原則（実行メタデータのみを載せる）に対する意図的な
> 例外で、緩和は保持期間（最大 7 日）とログ閲覧に `CLOUDFLARE_API_TOKEN` が要ることに
> 依っている。**D1 へ永続化する・他の feature へ同種のフィールドを広げる場合は、
> この判断をやり直すこと。**

上記 2 フィールド以外に、写真・質問文・抽出されたワイン名などのユーザ入力/出力を載せる口は
ない（`fieldSources` が持つのも「どこから来たか」と参照 URL だけで、抽出された値そのものは
持たない）。フィールドを増やすときは `inference-log.test.ts` のキー全列挙テストが落ちるので、
そこで privacy の是非を再確認する。

> [!IMPORTANT]
> **PRごとのプレビューURL（`https://<branch>-wine-preview.niboshi.workers.dev` /
> `https://<commit>-wine-preview.niboshi.workers.dev`）へのアクセスはログに残らない。**
> Cloudflare の [Preview URLs の制約](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations)で、
> Workers Logs・`wrangler tail`・Logpush のいずれからも参照できない（"You cannot view logs for
> Preview URLs today"）。`observability.enabled` の設定とは無関係で、回避策はない。
>
> `--env preview` で見えるのは、**デプロイ済みバージョン**（main のミラー、
> https://wine-preview.niboshi.workers.dev ）へのアクセス分のみ。
>
> したがって **PRのプレビューで踏んだエラーは、実機ログからは追えない**。PR段階では
> ローカル（`bun run dev`）で再現するか、`console.log` の代わりにエラーをレスポンスへ
> 出すなどブラウザから観測できる形にする。確実な実機ログはマージ後（本番、または
> main ミラーのプレビュー）で確認する。

検証記録（2026-07-25、PR #196）: 同一秒に本番とプレビューURLへ同じリクエストを投げたところ、
本番のみログに出た。プレビュー側はアプリが `{"ok":true}` を返しており Worker は実行されている。

| 対象 | 結果 |
|---|---|
| `https://wine.nibo.sh/api/auth/ok?probe=...` | ✅ 約30秒後にログ取得 |
| `https://claude-...-wine-preview.niboshi.workers.dev/api/auth/ok?probe=...` | ❌ 0件（5分待っても出ず） |

## クライアント側のエラー収集（Sentry）

Workers Logs は **サーバに届いたリクエストしか記録できない**。fetch がレスポンスを受け取る前に
失敗する類（圏外・回線断・大きすぎるアップロード）や、ブラウザ固有のAPI差異による失敗は
1件も残らない（#379 では `/api/wine-list-analysis` が7日間0件だった）。この穴を埋めるのが
クライアント側の収集で、実装は `src/lib/observability/client-error.ts`（唯一の入口）と
`sentry-client.ts`（Sentry の設定）。

- **DSN が未設定なら収集は丸ごと無効**。SDK のチャンク（約30KB gz）も読み込まれない。
  ローカルとCIでは設定しないこと。
- 有効化は **Workers Builds のビルド環境変数**で行う（`.env.example` に一覧がある）。

| 変数 | 種別 | 役割 |
|---|---|---|
| `VITE_SENTRY_DSN` | ビルド変数（公開値） | 収集先。未設定なら収集を無効化する |
| `VITE_SENTRY_RELEASE` | ビルド変数 | リリース識別子。`WORKERS_CI_COMMIT_SHA` を渡す |
| `SENTRY_AUTH_TOKEN` | ビルドシークレット | ソースマップのアップロード用 |
| `SENTRY_ORG` / `SENTRY_PROJECT` | ビルド変数 | アップロード先 |

- **`SENTRY_AUTH_TOKEN` がある環境でだけ**ソースマップの生成・アップロードが走る。トークンの
  有無でビルドの成否は変わらない（CI は未設定のまま `bun run build` / `check:deploy` が通る）。
- アップロードが失敗しても**ビルドは成功する**（Sentry 側の障害でデプロイを止めない）。その場合は
  そのリリースだけスタックが復元できない状態になる。
- ソースマップは**アップロード後に dist から削除する**。残すと静的アセットとして公開配信され、
  誰でもクライアントの原文を読めてしまう。アップロード失敗時も削除される（公開されるより安全な側）。
- `@sentry/cli`（アップロード用バイナリ）は `package.json` の `trustedDependencies` に入れてある。
  bun は既定でライフサイクルスクリプトを実行しないため、外すとアップロードだけが静かに失敗する。

環境名（`production` / `preview` / `local`）はドメインから導出するので、プレビューごとに変数を
設定する必要はない。

### 初回セットアップ（手作業）

1. Sentry で組織とプロジェクト（platform: `javascript-react`）を作り、**DSN** を控える
   （Settings > Projects > *project* > Client Keys (DSN)）
2. ソースマップ用の **Organization Auth Token** を発行する（Settings > Auth Tokens）。
   必要なスコープは `project:releases` と `org:read`
3. Workers Builds のビルド環境変数に設定する。ダッシュボード（*Worker* > Settings > Build >
   Build variables and secrets）か、下記「設定の確認・変更（Workers Builds API）」の
   `build_variables` を PATCH する。**本番 `wine` とプレビュー `wine-preview` の両トリガーに要る**
   - `VITE_SENTRY_DSN` / `SENTRY_ORG` / `SENTRY_PROJECT`（変数）
   - `VITE_SENTRY_RELEASE` = `$WORKERS_CI_COMMIT_SHA`
   - `SENTRY_AUTH_TOKEN`（**シークレットとして**登録する）
4. 空コミット等で再ビルドし、ブラウザの Network タブで `ingest.sentry.io` への送信が出ることを確認する

> `build_variables` は**丸ごと置き換わる**。既存の `BUN_VERSION` / `CLOUDFLARE_ENV` を含めた
> 完全な集合を送ること（詳細は下記 API の節）。

### Terraform 管理にしない理由

Stripe リソースは Terraform 管理だが、**Sentry は当面ダッシュボードでの手作業とする**。理由:

- Terraform 管理下に入るのは実質「プロジェクト1個 + Client Key 1個」で、Stripe（Product /
  Price×2 / Coupon / PromotionCode / Webhook / Portal）のようにドリフトが痛むほどの量がない
- **Cloudflare 側は Terraform で閉じない**。Cloudflare プロバイダに Workers Builds の
  トリガー設定（build command / deploy command / `build_variables`）を扱うリソースが無いため、
  Terraform を足しても設定手順が2系統に増えるだけになる
- Sentry 側を Terraform 化する場合は [`jianyuan/sentry`](https://registry.terraform.io/providers/jianyuan/sentry/latest)
  （Sentry 公式スポンサー）が使え、`sentry_key` から DSN を output できる。**アラートルールや
  ノイズフィルタ（`sentry_issue_alert` / `sentry_project_inbound_data_filter`）を育て始めたら**
  移行を検討する。そこは経緯が残らないと痛む種類の設定なので Terraform 向き

## サーバ側の運用通知（Sentry / #395）

**運用者が手を動かさないと直らない事象**だけを、Workers から Sentry へ直接送る。クライアント側の
収集（上記 `VITE_SENTRY_DSN`）とは投入先が別で、**サーバは `SENTRY_DSN` シークレット**を使う。

| | クライアント | サーバ |
|---|---|---|
| 変数 | `VITE_SENTRY_DSN`（ビルド変数） | `SENTRY_DSN`（Worker シークレット） |
| 送信 | `@sentry/react`（動的 import） | `fetch` で envelope を1本（SDK なし） |
| 入口 | `reportClientError`（#381） | `alertOperator`（`src/lib/observability/operator-alert.ts`） |

同じプロジェクトへ送ってよい。イベントには `logger: "worker"` と `runtime: "workers"` タグが付く
ので、Sentry 側で `logger:worker` で絞れる。分けたければサーバ用プロジェクトを作って DSN を変える。

### 投入

```bash
# 本番
bunx wrangler secret put SENTRY_DSN
# プレビュー（デプロイ済みバージョンに対して）
bunx wrangler versions secret put SENTRY_DSN --env preview
```

**未設定でもアプリは動く**（ログには従来どおり出て、送信だけしない）。ローカルは `.dev.vars` に
書けるが、通常は入れない（開発中のエラーで本番のアラートを鳴らさないため。環境名は
`BETTER_AUTH_URL` のホストから導出され、localhost は `local` になる）。

### 何が送られるか

| kind | level | 意味 / 運用者の行動 |
|---|---|---|
| `billing_extension_unconfirmed` | error | 延長コードの適用結果が不明。Stripe 側を見て決着させる |
| `billing_extension_compensation_failed` | error | 延長できていないのに引換行が残った。行を消す |
| `credit_refund_failed` | error | 推論失敗の返却に失敗。台帳から手で戻す |
| `credit_orphan_reclaim_failed` | error | 焼き付いた予約の回収に失敗。原因を見て手で戻す |
| （管理操作の監査記録失敗） | error | 操作は適用済みで証跡が無い。監査ログを手で補う |
| `ai_inference_failed` | warning | 推論の失敗。**1件ずつは対応不要**で、見たいのは頻度 |
| `ai_pricing_missing` | warning | 単価表に無いモデルで課金中。価格表を直す |

> [!IMPORTANT]
> **閾値はコード側に持たせていない。** 「失敗が急増したら知らせる」は Sentry のアラートルール
> （件数/期間）で設定する。実装側で閾値を発明すると、変えるたびにデプロイが要り、
> かつ isolate 分散のため件数を正しく数えられない（#178 と同じ理由）。
>
> 最低限、次の2本を Sentry で作っておく:
> 1. `logger:worker` かつ `level:error` → 発生したら即通知
> 2. `kind:ai_inference_failed` → 一定時間内の件数が閾値を超えたら通知（原価だけが出ていく状態）

### 送らないもの

`webResearch` / `fieldSources`（エチケット解析の裏取り情報）は**送らない**。解析した銘柄が復元
できるため、保持7日・APIトークン必須の Workers Logs に限る取り決めになっている（上記
「エチケット解析の裏取りを追う」の CAUTION）。`alertOperator` へ渡すフィールドは呼び出し側が
明示的に選ぶ（AI 実行記録は `recordInference` が部分集合だけを渡す）。

## シークレットの投入

### `BETTER_AUTH_SECRET` は全環境で必須

セッション Cookie の署名・OAuth の state/consent・MCP OAuth のトークン発行に使う鍵。
**未設定でもアプリは起動してしまう**のが罠で、better-auth が OSS に書かれた公開の既定値
（`better-auth-secret-…`）へ黙ってフォールバックする。この状態の環境は、署名鍵が公知なので
**誰でも有効な署名の Cookie を自作でき、任意セッションになりすませる**。

better-auth 自身の「既定値のままなら起動を拒否する」ガードは条件が `NODE_ENV === "production"`
だが、**workerd では `process.env.NODE_ENV` が設定されないため発火しない**（Vite の静的置換も、
better-auth 側が Proxy 経由の動的プロパティアクセスで読むので効かない）。実際、preview は
長期間このガードをすり抜けて既定シークレットで稼働していた（Issue #389）。

そのため `src/lib/auth.ts` が起動時に自前で検査し、未設定・既定値のままなら `logError` を出す
（判定は `src/lib/auth-secret.ts`）。**デプロイ後は `bun run logs --level error --grep BETTER_AUTH_SECRET`
で1行も出ないことを確認する**。起動拒否にしていないのは、シークレット未投入の環境が丸ごと
起動不能になると投入するまで全PRのプレビューが止まるため。

```bash
# 生成
npx wrangler secret put BETTER_AUTH_SECRET                      # 本番 (wine)
npx wrangler versions secret put BETTER_AUTH_SECRET --env preview  # プレビュー (wine-preview)
# 設定済みかの確認(値は表示されない)
npx wrangler secret list
npx wrangler secret list --env preview
```

**投入するとその環境の既存セッションは全て無効になる**（署名鍵が変わるため）。ログインし直しが
必要になるだけで、データは失われない。

### 環境ごとの非対称性

過去のCI整備（PR #59/#63〜#67）で繰り返し踏んだ非対称性のまとめ。

- **本番（`wine`）とプレビュー（`wine-preview`）でコマンドが異なる**。`wine-preview` は `wrangler versions upload` 運用のため `wrangler secret put` が
  `latest version isn't currently deployed` で失敗する → `npx wrangler versions secret put <NAME> --env preview` を使う。本番は従来どおり `npx wrangler secret put <NAME>`（PR #66）。
- **シークレット追加後、既存のプレビューには反映されない**。新しいビルドを走らせる（空コミット等）必要がある（PR #59）。
- Terraform（R2 バックエンド）では、`terraform apply` だけでなく **`terraform output` を実行するステップにも R2 の AWS 系認証情報が必要**
  （`No valid credential sources found` で失敗する。PR #64）。GitHub Actions のステップ `if:` 式では `secrets` コンテキストを参照できないため、env に展開してから判定する（PR #60）。

## 設定の確認・変更（Workers Builds API）

ダッシュボード UI のほか、[Workers Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
でトリガー設定を確認・更新できる。`CLOUDFLARE_API_TOKEN`（Workers Scripts 編集権限）が必要。

```bash
ACC=<account_id>
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
API=https://api.cloudflare.com/client/v4

# Worker の script tag を取得
curl -sS "$API/accounts/$ACC/workers/services/wine" -H "$AUTH" \
  | jq -r '.result.default_environment.script_tag'

# その tag のトリガー一覧（build_command / deploy_command を確認）
curl -sS "$API/accounts/$ACC/builds/workers/<script_tag>/triggers" -H "$AUTH" | jq

# トリガーの deploy command を更新
curl -sS -X PATCH "$API/accounts/$ACC/builds/triggers/<trigger_uuid>" -H "$AUTH" \
  -H "Content-Type: application/json" \
  --data '{"deploy_command":"bun run db:migrate:remote && npx wrangler deploy"}'

# ビルド環境変数に bun のバージョンを固定する(#339。package.json の packageManager と同じ値にする)
curl -sS -X PATCH "$API/accounts/$ACC/builds/triggers/<trigger_uuid>" -H "$AUTH" \
  -H "Content-Type: application/json" \
  --data '{"build_variables":{"BUN_VERSION":"1.3.11"}}'
```

> `build_variables` は**丸ごと置き換わる**。既存の変数（`wine-preview` の `CLOUDFLARE_ENV=preview` など）が
> あるトリガーでは、先に GET した内容へ追記した完全な集合を送る。

> 設定変更は「次回以降のビルド」に適用される。既存の実行中ビルドには影響しない。
