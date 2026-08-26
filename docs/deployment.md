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

## ランタイムトレースの確認

`wrangler.jsonc` の `observability.traces.enabled: true` により、本番・プレビューとも
**Workers Traces** にトレースが蓄積される（#504）。`observability` は env 継承されるため、
設定はトップレベルの1箇所だけで両環境に効く（`ratelimits` や `d1_databases` のように env ごとへ
書き直す必要はない）。

**ログとの使い分け**: ログは「その時点で何が起きたか」の点の記録で、トレースは「1リクエストの
中で何がどの順にどれだけ掛かったか」の構造。`bun run logs` で失敗を見つけ、同じ操作のトレースを
`bun run traces` で見て、どの D1 クエリ・どの外部 fetch・どの推論が原因かまで降りる。

```bash
bun run traces                            # 本番(wine)の直近1時間
bun run traces --env preview --since 3h   # プレビュー(wine-preview)の直近3時間
bun run traces --grep ai_inference        # スパン名の部分一致
bun run traces --trace <trace-id>         # そのトレースのスパンを親子で表示(属性つき)
bun run traces --version <version-id>     # 特定バージョンに限定
bun run traces --json                     # 生JSON(jq で加工する場合)
```

一覧は「1リクエスト = 1行」で、そこから `--trace` で中身に降りる:

```
$ bun run traces --since 30m
2026-08-17 09:11:40.061Z POST https://wine.nibo.sh/api/mcp 783ms spans=4 trace=df94454ed334…

$ bun run traces --trace df94454ed3341035b077cf8d8fc3fd17
# trace df94454ed3341035b077cf8d8fc3fd17 / 4スパン
  POST 783ms
    d1_all 591ms
    d1_all 192ms
    mcp_tool 0ms  wine.mcp.tool=list_aops
```

> [!IMPORTANT]
> **トレースのデータセットはログと別で `otel`**（`scripts/traces.mjs` の `DATASETS`）。ログの
> `cloudflare-workers` を渡すと **API は 200 と 0 件を返す**——データセット名は検証されないため、
> 「指定が違う」と「その期間にトラフィックが無い」を区別できない。#505 の CLI はこれで常に0件を
> 返していた（#506）。0件が続くときは、まずデータセットとフィルタのキーを疑う。

### 何が計装されるか

コード変更なしで自動計装されるのは、**ハンドラ**（`fetch` / `queue`）・**バインディング**
（D1・R2・Images・Queues・Rate limiting）・**外向き `fetch`** の呼び出し。

**`env.AI`（Workers AI）は自動計装の対象外**で、このアプリで最も遅く最も壊れる経路が
トレースに現れない。そこはカスタムスパン（`src/lib/observability/span.ts` の `withSpan`）で
補っている。**スパンを張るのはこの3箇所だけ**で、`tracing.enterSpan` を経路ごとに直書きしない
（経路が増えたときに後発の経路で必ず漏れるため。#166 / #174 と同じ失敗の形）。

| スパン名 | 張っている場所 | 主な属性 |
|---|---|---|
| `ai_inference` | `finishMeteredInference`（全AI経路が通る） | `wine.ai.feature` / `wine.ai.request_id` / `wine.ai.route` / `wine.ai.executed_by` / `wine.ai.model` / `wine.ai.outcome` / `wine.ai.cost_micro_usd` |
| `label_job` | キューコンシューマの1メッセージ処理（`src/worker.ts`） | `wine.job.id` / `wine.queue.message_id` |
| `mcp_tool` | MCPツール登録の入口（`src/lib/mcp/tool-tracing.ts`） | `wine.mcp.tool` |

> [!IMPORTANT]
> **スパンの属性に載せてよいのは実行メタデータだけ。** userId・ワイン名・検索クエリのような
> 「誰が何をしたか」が復元できる値は載せない。同種の値が Workers Logs には載っているが、
> あれは保持7日・閲覧に `CLOUDFLARE_API_TOKEN` が要るという前提での判断（上記「AI 推論の実行記録」
> 参照）で、**スパンは OTLP エクスポートを1つ設定した時点で外部の別基盤へ出ていく**。
> ログ側と突き合わせたいときは `wine.ai.request_id` を使う（台帳・実行記録と同じキー）。

### 課金とサンプリング

ベータ期間中は無料だが、**2026-10-01 から span 1件 = observability event 1件**として
Workers Logs と同じ枠で課金される（Workers Paid: 2000万/月込み、超過 $0.60/百万、保持7日）。

`head_sampling_rate` は**指定していない**（既定 1.0 = 全件）。全リクエストが追えるほうが
「再現しない不具合」の切り分けに効くため。超過が見えたら wrangler.jsonc の `observability.traces`
に `"head_sampling_rate": 0.1` を足して絞る（ログ側の `observability.logs` とは独立に設定できる）。

> [!IMPORTANT]
> **PRごとのプレビューURLのトレースは、ログと同じく取得できない。** Preview URLs の制約は
> トレースにも同じく掛かる（上記のログの項を参照）。`--env preview` で見えるのはデプロイ済み
> `wine-preview`（main ミラー）への分のみ。
>
> また **設定を含むデプロイより前のリクエストには遡れない**。`observability.traces` を有効に
> した時点以降のリクエストだけがトレースに残る。

## Langfuse でのAI推論トレース（#512）

AI 推論の **入出力（プロンプト/応答）そのもの**を追うための観測。Workers Logs / Traces / Sentry では
入出力を載せない規約だったため、「プロンプトが悪いのか・モデル応答が悪いのか・パースが悪いのか」を
切り分けられなかった穴を埋める。実装は `src/lib/observability/langfuse.ts`（唯一の入口）と
`src/lib/observability/langfuse-mask.ts`（マスクの関門）。

### 観測先ごとのPII方針の書き分け

| 観測先 | 入出力 | 根拠 |
|---|---|---|
| Workers Traces（`withSpan`） | 載せない（実行メタデータのみ） | 全スパンが対象で、OTLPエクスポートを1つ足すと無条件に外へ出る |
| Workers Logs（`logAiInference`） | 検索クエリ・参照URLのみ | 保持7日・`CLOUDFLARE_API_TOKEN` 必須 |
| **Langfuse（新規）** | **テキストの入出力を載せる／写真は載せない** | 意図的に選んだ経路だけを送る。保持30日・キー必須 |

写真を含む経路は、写真そのものではなく**枚数・MIME・寸法・ハッシュ**だけを載せる。
`mediaUploadEnabled: false` を明示し、写真がメディアストレージへ上がる経路を塞ぐ。
`mask` フック（`langfuse-mask.ts`）が `data:` URI・base64らしき長大文字列・認証情報らしき値を
機械的に落とす唯一の関門（純関数として unit テストで固定）。

### 相関

`requestId`（`credit_ledger.request_id` と同値。`createTraceId(requestId)` で決定的に導出）で
Workers Logs の `ai inference` 行・クレジット台帳・Langfuse のトレースURLが直結する。

```bash
bun run logs --grep "ai inference" --since 1d   # requestId を拾う
# → Langfuse ダッシュボードで traceId = createTraceId(requestId) を検索
```

### ホスティングとコスト

Langfuse Cloud **JPリージョン**（`https://jp.cloud.langfuse.com`）を使う。
1 observation = 1 unit。Hobby 無料枠は 50,000 units/月・保持30日・**超過課金なしのハードキャップ**
（枠を超えるとトレースが黙って止まる）。

| 機能 | 1回あたりの observation |
|---|---|
| 地域Q&A | 2（trace + generation） |
| エチケット解析（Workers AI） | 2〜7（trace + 写真枚数ぶんの generation。最大6枚） |
| エチケット解析（Claude 経路） | 2〜4（trace + リクエストごとの generation。pause_turn の継続も1件ずつ） |
| エチケット解析（GPTエージェントループ） | **実測 4件（1ステップで収束）〜 11件（3ステップ: generation×3 + `submit_answer`×2 + web検索×3 + マスタ参照×2 + trace）**。`AI_LABEL_AGENT_MAX_STEPS = 8` まで回しきると 30 前後に達しうる |
| 一括抽出（GPT経路） | 2（trace + generation） |
| 一括抽出（Claude経路） | 2〜5（trace + リクエストごとの generation。pause_turn の継続も1件ずつ） |

**Phase 3(#515) で全AI経路の計装が揃った。** 新しい `AiFeature` を足すときは
`AI_FEATURE_GENERATION_PREFIXES`（`src/lib/ai/inference-log.ts`）への登録が型で強制され、
対応する workers テストが generation の名前接頭辞を OTLP から検証する。

### 月間 units の見通し（全経路載せた状態）

1推論あたりの中央値を「地域Q&A 2 / エチケット解析 4〜11 / 一括抽出 2〜3」とすると、
**1,000回のAI推論で約 3,000〜5,000 units**。Hobby 無料枠（50,000 units/月）なら
**月1万回前後の推論**までは吸収できる計算で、現行の利用規模（クレジット消費から見て
月数百回程度）に対しては十分な headroom。枯渇の兆候（トレースが止まる）は
Langfuse ダッシュボードの usage で月次を確認する。

写真は generation の**メタデータ**(`photos`: MIME・寸法・バイト数・SHA-256)と、入力テキスト内の
要約オブジェクト(`$photo`)として載せる。入力テキストは mask の上限(8,000字)で切り詰められる
ことがあるが、メタデータは別属性なのでインベントリは生きる。

全環境（本番・デプロイ済みpreview・PRプレビュー・ローカル）から送る方針なので、開発中の試行も枠を食う。

### 無料枠が枯渇したときの間引き手順

超過課金は無いが、枠を超えるとトレースが黙って止まる。次の順で間引く:

1. `src/lib/observability/langfuse.ts` の `shouldExportSpan` でツールspanだけ落とす（generation は残す）
2. それでも足りなければ Langfuse Cloud を Core $29/月に上げる

### セットアップ

1. Langfuse Cloud JP でプロジェクト作成 → `pk-lf-…` / `sk-lf-…` を発行
2. `wrangler secret put LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` を**本番 `wine` と `--env preview` の両方**へ
3. ローカル用に `.dev.vars` へ同じ2つを記載（`.dev.vars.example` 参照）

未設定でもアプリは壊れない（no-op）。`wrangler secret put` 前でもマージ・デプロイは可能。

### プロンプト管理（#512 Phase 4）

**本番プロンプトの正（SSOT）は Langfuse にある。** コードの
`src/lib/ai/managed-prompts.ts`（`MANAGED_PROMPTS`）が持つ `template` は
「Langfuse が使えないときの fallback」と「初期登録の種」であって、正ではない。

これは #512 本文の「Langfuse Prompts は使わない」を意図的に覆した決定で、
**デプロイと無関係にモデルの挙動が変わることを許容する**代わりに、評価のループ
（編集 → 試す → 比較 → 採用/巻き戻し）がデプロイ待ちで分断されない状態を取っている。
CI がプロンプトの網でなくなるぶんは、下記のラベル運用と実行時ガードで御する。

取得の唯一の入口は `src/lib/observability/langfuse-prompt.ts` の `getManagedPrompt`。
`ai-service.ts` に `LangfuseClient` を直書きしない（`startObservation` を直書きしないのと同じ理由）。

対象は現時点で **地域Q&A の system プロンプト（`region-qa-system`）だけ**。

#### ラベルで本番と評価中を分ける

| 実行環境 | 引くラベル |
|---|---|
| 本番 `wine` | `production` |
| デプロイ済みプレビュー / PRプレビュー / ローカル | `preview` |

判定は `resolveServerEnvironment()`（Langfuse の `environment` と同じ導出）。評価はこう回す:

1. Langfuse UI でプロンプトを編集して新しい版を作り、**`preview` ラベル**を張る
2. プレビューURL（またはローカル）で実行し、トレースで応答・latency・コストを版ごとに比べる
3. 良ければ `production` ラベルを張り替える（**デプロイ不要**）
4. 悪ければラベルを元の版へ戻すだけ（版履歴は Langfuse が保つ）

`preview` ラベルの版が無ければ Langfuse は 404 を返し、コードの fallback で動く。
つまり**ラベルを張ったときだけ本番と違う挙動になる**。

**ラベルを張り替えても即座には反映されない。** SDK のキャッシュは stale-while-revalidate で、
TTL(60秒)が切れた後の**最初のリクエストは古い版をそのまま返し**、裏で取得し直す。新しい版が
出るのは**その次のリクエストから**。実機で確認するときは「変わらない」と早合点せず、
TTL ぶん待ってから2回試すこと(実測でこの挙動を確認済み)。Workers は isolate が短命なので
本番では冷えた isolate が新しい版を直接引くことが多いが、温まっている間はこのラグが乗る。

#### 実行時ガード（型とテストを失ったぶんの代替）

取得した版は、次のどれかに当たると**使わずにコードの fallback へ落ちる**。理由は
generation の `metadata.promptSource` に残るので、トレースから必ず追える。

| `promptSource` | 意味 |
|---|---|
| `langfuse` | Langfuse の版で動いた（prompt link に版番号が載る） |
| `code-no-keys` | 鍵が未設定。外向き fetch を1本も出していない |
| `code-fetch-failed` | Langfuse に届かなかった / タイムアウト（`fetchTimeoutMs: 2000`） |
| `code-invalid-template` | **版の変数がコードと食い違う**（下記） |

`code-invalid-template` になるのは2方向:

- **必須変数が消された**（`{{region_context}}` を消すとグラウンディング無しで推論が走る）
- **コードが渡さない変数が足された**（mustache は未知の変数を空文字に畳むので、書いた本人の
  意図した文面にならないまま本番へ出る）

後者の結果として、**変数を増やす版はコード側が追随するまで効かない**。それが狙いで、
効かなかったことは Workers Logs の `op: langfuse_prompt` の warn と `promptSource` から分かる。

`isFallback` の版には Langfuse SDK が prompt 属性を付けないので、**fallback で動いた回が
版ごとの指標を汚さない**。

**Langfuse に届かなかった回は Workers Logs にも warn を出す。** その状況では
トレース自体が Langfuse へ届かないので、`promptSource` は当てにできない —— 一番知りたい
ときに唯一届く信号が Workers Logs になる:

```bash
bun run logs --grep langfuse_prompt --since 1d
# {"msg":"langfuse prompt fetch fell back to code","op":"langfuse_prompt",
#  "prompt":"region-qa-system","label":"preview"}
```

取得は**リトライしない**（`maxRetries: 0` / `fetchTimeoutMs: 2000`）。地域Q&Aは同期経路で
この fetch が推論の前に直列で入る上、**失敗はキャッシュされない**（キャッシュに入るのは
成功した取得だけ）ので、Langfuse が落ちている間は毎リクエストがこの待ちを払う。1回で
諦めることで上乗せの最悪値を `fetchTimeoutMs` 1回ぶんに抑える。

#### 初期登録と差分の確認

```bash
bun run sync:prompts             # 未登録があれば production / preview ラベル付きで登録
bun run sync:prompts --dry-run   # 書き込まず、やることだけ表示
bun run sync:prompts --check      # 差分・未登録があれば非ゼロ終了
```

**上書きはしない。** 登録済みなら本文を比べて差分を表示するだけ。差分は異常ではなく
「Langfuse 側で改善した版が育っている」という意味なので、離れすぎたら fallback を
コードへ取り込み直す（取り込みは手で書く）。**CI からは実行しない**（Langfuse の鍵を
GitHub Actions へ置かない。鍵の投入は Sentry / Stripe と同じく手作業）。

#### Playground / Datasets / Experiments

Langfuse Playground の LLM Connection に **Cloudflare Workers AI のプリセットは無い**。
Cloudflare AI Gateway の OpenAI 互換エンドポイントを通す:

1. Cloudflare で AI Gateway を作る
2. Langfuse の Project Settings → LLM Connections → Add new LLM API key
3. Provider は **OpenAI**、Advanced Settings の Base URL に
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>/compat` を入れる
   （Langfuse が `/chat/completions` を付けるので**末尾に付けない**）
4. モデル名は `workers-ai/@cf/google/gemma-4-26b-a4b-it` の形で指定する

Dataset は既存トレースから作れる（Traces の一覧で選択 → Add to dataset）。地域Q&Aの実リクエストを
数十件拾って回帰用にしておくと、プロンプトを変えたときに Experiments で前後比較できる。

### PRプレビューでもトレースが見えることの価値

`docs/deployment.md` の「ランタイムログの確認」にあるとおり、**PRごとのプレビューURLは Workers Logs も
Traces も一切取得できない**（Cloudflare Preview URLs の制約）。Langfuse はアプリが自前で
`fetch` で OTLP を送るため、この制約を受けず、**PRプレビューからもトレースが届く**。
Phase 1 で地域Q&Aを実行して到達することを確認する。

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
| `VITE_SENTRY_RELEASE` | **build command 内で渡す** | リリース識別子。下記の注意を参照 |
| `SENTRY_AUTH_TOKEN` | ビルドシークレット | ソースマップのアップロード用 |
| `SENTRY_ORG` / `SENTRY_PROJECT` | ビルド変数 | アップロード先 |

> **`VITE_SENTRY_RELEASE` をビルド変数に置いても展開されない**。ビルド変数の値は文字列として
> そのまま環境変数になるので、`$WORKERS_CI_COMMIT_SHA` と書くとリテラルのその文字列が入る。
> シェルで展開させるには **build command 側**に書く:
>
> ```
> bun install --frozen-lockfile && VITE_SENTRY_RELEASE=$WORKERS_CI_COMMIT_SHA bun run build
> ```
>
> 未設定でも収集は動く（アップロードしたソースマップとイベントを紐づけられなくなるだけ）。

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

1. Sentry で組織とプロジェクトを作り、**DSN** を控える
   （Settings > Projects > *project* > Client Keys (DSN)）。
   **オンボーディングのウィザードはプラットフォームごとに別プロジェクトを作る**ので、
   TanStack Start 用と Cloudflare 用を両方通すと DSN が2つになる。フロントとサーバの失敗は
   同じ操作で連鎖する（#379）ため**1プロジェクトにまとめる**。environment
   （`production` / `preview` / `local`）で分ければ足りる
2. ソースマップ用の **Organization Auth Token** を発行する（Settings > Auth Tokens）。
   必要なスコープは `project:releases` と `org:read`
3. Workers Builds のビルド環境変数に設定する。ダッシュボード（*Worker* > Settings > Build >
   Build variables and secrets）か、下記「設定の確認・変更（Workers Builds API）」の
   `build_variables` を PATCH する。**本番 `wine` とプレビュー `wine-preview` の両トリガーに要る**
   - `VITE_SENTRY_DSN` / `SENTRY_ORG` / `SENTRY_PROJECT`（変数）
   - `SENTRY_AUTH_TOKEN`（**シークレットとして**登録する）
   - `VITE_SENTRY_RELEASE` は build command 側に書く（上記の注意を参照。省略可）
4. 空コミット等で再ビルドし、ブラウザの Network タブで `ingest.sentry.io` への送信が出ることを確認する
5. 収集が届くことの確認は、テスト用のボタンを足さずに**既存の計測点を踏ませる**のが確実:
   DevTools の Network を Offline にして `/cellar/new` で写真付きエントリを保存 →
   オンラインに戻すと、オフラインキューから `TypeError: Failed to fetch` が届く
   （AIクレジットを消費しない経路）

> **Sentry のオンボーディング手順はそのまま使えない。** TanStack Start 版が案内する
> `@sentry/tanstackstart-react` は `workerd` の export condition が `@sentry/node` に解決され、
> Worker が "Cannot initialize ExportedHandler" で起動しなくなる
> （getsentry/sentry-javascript#20038、closed as not planned）。`instrument.server.mjs` /
> `--import` / `.output/server` といったサーバ側の手順も Node 前提で Workers には無い。
> **必要なコードは実装済みなので、ウィザードでやることは DSN とトークンの発行だけ**。

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

| | クライアント | サーバ（operator-alert） | サーバ（withSentry） |
|---|---|---|---|
| 変数 | `VITE_SENTRY_DSN`（ビルド変数） | `SENTRY_DSN`（Worker シークレット） | `SENTRY_DSN`（Worker シークレット） |
| 送信 | `@sentry/react`（動的 import） | `fetch` で envelope を1本（SDK なし） | `@sentry/cloudflare`（#486） |
| 入口 | `reportClientError`（#381） | `alertOperator`（`src/lib/observability/operator-alert.ts`） | `withSentry` による自動計装（`src/worker.ts`） |
| 対象 | クライアントの予期しない例外 | 意図して選んだ少数の事象（決済の宙吊り等） | サーバの予期しない例外（SSR / server function / キューコンシューマ） |

同じプロジェクトへ送ってよい。イベントには `logger: "worker"` と `runtime: "workers"` タグが付く
ので、Sentry 側で `logger:worker` で絞れる。分けたければサーバ用プロジェクトを作って DSN を変える。

> [!NOTE]
> `withSentry`（#486）は fetch / scheduled / queue / email / tail を自動計装し、ハンドラが
> throw した例外をキャプチャする。`alertOperator` は置き換えず補完の関係で、
> 「意図して選んだ少数の事象」は従来どおり `logger:worker` タグ付きで届く。トレースは
> 入れていない（`tracesSampleRate` 未設定）ので、トランザクション/スパンは送られない。

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
