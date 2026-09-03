## ランタイム / 開発コマンド

* このアプリは Cloudflare Workers にデプロイする（ランタイムは Node.js ではない）。ローカルのタスクランナーは Bun を使う。
* マージ前チェック（CIと同一）: `bun run typecheck` / `bun run check` / `bun run build` / `bun run test`
* `bun run test` は3プロジェクト構成（`vitest.config.ts`）。`unit`=jsdom 上の純ロジック単体テスト（`*.test.ts`）、`workers`=`@cloudflare/vitest-pool-workers` で workerd+実D1(miniflare) を用意して D1/`env` 依存コードを検証するテスト(`*.workers.test.ts`、`test/apply-migrations.ts` がマイグレーション適用）、`start-workers`=実際のアプリ Worker(`src/worker.ts`)とTanStack Startのserver-function transportをworkerd上で検証する統合テスト。D1・`env` に触れる挙動のテストは後者に置く（分離D1で本番/プレビューには触れない）。
* ローカルDB: 初回・スキーマ変更後は `bun run db:migrate:local` してから `bun run dev`
* OAuth/MCP をローカル検証する場合は `.dev.vars` に `BETTER_AUTH_URL=http://localhost:3000` を設定（`.dev.vars.example` 参照）
* デプロイ済み環境のランタイムログは `bun run logs`（本番 `wine`）/ `bun run logs --env preview`（デプロイ済み `wine-preview` = main ミラー）で検索する。`--level error,warn` / `--grep <text>` / `--since 3h` で絞り込む。CIは緑なのに実機で壊れる類の切り分けに使う（`wrangler tail` はライブのみで後追いできない）。
* デプロイ済み環境のランタイムトレースは `bun run traces`（`--env preview` / `--grep ai_inference` / `--since 3h`）で検索する。ログが「その時点で何が起きたか」の点の記録なのに対し、トレースは「1リクエストの中で何がどの順にどれだけ掛かったか」の構造で、遅さ・どのD1クエリが失敗したかの切り分けに使う。自動計装（ハンドラ・D1・R2・Images・Queues・Rate limiting・外向き fetch）に加え、**Workers AI は自動計装の対象外**なのでカスタムスパンで補っている（`src/lib/observability/span.ts` の `withSpan` が唯一の入口。経路ごとに `tracing.enterSpan` を直書きしない）。詳細は `docs/deployment.md` の「ランタイムトレースの確認」を参照。
* Langfuse でのAI推論トレースは `finishMeteredInference` が唯一の入口（`src/lib/observability/langfuse.ts`）。**AI経路を足したら `ctx.recordGeneration()` で Langfuse の計装も通す**こと（`ai-service.ts` に `startObservation` を直書きしない。`#166` / `#174` と同じ失敗の形を避ける）。詳細は `docs/deployment.md` の「Langfuse でのAI推論トレース」を参照。
* **`region-qa-system` などのプロンプト本文の正（SSOT）は Langfuse 側にある**（#512 Phase 4 で「使わない」判断を覆した）。コードの `src/lib/ai/managed-prompts.ts` が持つ `template` は fallback と初期登録の種であって正ではない。取得は `getManagedPrompt`（`src/lib/observability/langfuse-prompt.ts`）が唯一の入口で、`ai-service.ts` に `LangfuseClient` を直書きしない。**プロンプトを Langfuse 管理下へ足すときは `MANAGED_PROMPTS` に登録し、マスタ由来の一覧や共有フラグメントはテンプレートへ焼き込まず変数として注入する**。本番はデプロイ無しで変わりうるので、変数を増減させる版はコード側の追随まで実行時ガードが弾く（`promptSource` で追える）。詳細は `docs/deployment.md` の「プロンプト管理」を参照。
* **PRごとのプレビューURL（`<branch>-wine-preview.*`）のログ・トレースは取得できない**。Cloudflare の Preview URLs の制約で Workers Logs・`wrangler tail`・Logpush のいずれからも見えず、回避策はない。PR段階の不具合はローカル（`bun run dev`）で再現するか、ブラウザから観測できる形にして切り分ける。実機ログ・トレースはマージ後に確認する。詳細は `docs/deployment.md` の「ランタイムログの確認」を参照。

## 実装プランの作成

プランの作成時は、検討が必要な項目を徹底的に洗い出し、曖昧性が完全に排除されるまでユーザに質問・確認を行なってください。

## 複数セッションでのIssue並行処理（claimプロトコル）

`issue-claim-protocol` skill に従う。リポジトリ固有設定:

- CLAIM_SCOPE: `user:mpppk`
- CLAIM_LABEL: `in-progress`
- CLAIM_RESOURCES:
  - `db-schema`: `drizzle/**`, `src/db/schema.ts`, `src/db/auth-schema.ts`
  - `aops-data`: `src/lib/wine/aops.json`
  - `terraform`: `terraform/**`
  - `lockfile`: `bun.lock`
  - `ci-config`: `.github/workflows/**`

`db-schema` は下記「スキーマ変更を含むPRは同時に複数オープンしない」（Issue #54）を、claim時に機械的に効かせるためのもの。全プレビュー環境が共通D1を共有する以上 `drizzle/` と Drizzle 実行時クエリ層は常に一緒に変わるので、1つのリソースとしてまとめて排他する。

## MCPサーバー変更時の動作確認

`src/lib/mcp/` や `src/routes/api/mcp.ts`（OAuth 関連の `src/lib/auth.ts` / `.well-known/*` / `oauth/consent` / 埋め込みビュー `src/routes/embed/`）を変更したら、`mcp-inspector-verify` skill を使い、MCP Inspector で OAuth 接続〜`tools/list`〜`list_aops`（または `show_aop_map`）実行〜（UI に関わる変更は Apps タブでの App 描画）まで実機確認する。結果は PR の Test Plan / 動作確認結果に記載する。

## DBスキーマ変更を含むPR

* マイグレーションは `drizzle/` に**手書きの連番SQL**で追加する（`0000_*.sql`, `0001_*.sql`, …。`IF NOT EXISTS` 付き・既存ファイルは書き換えず新しい連番を積む等の規約は `docs/architecture.md` を参照）。`src/db/schema.ts`（ドメインテーブル）と `src/db/auth-schema.ts`（better-auth の `user`/`session`/`account`/`verification`/`oauth_*` と Stripe の `subscription`）は Drizzle ORM の実行時クエリ層であり、スキーマ変更はこれらに合わせて次番のSQLを手書きする。`wrangler d1 migrations apply DB` が連番SQLを適用する。better-auth / Stripe 関連テーブルは各プラグインのスキーマ定義と突合すること。
* `drizzle-kit`（`db:generate` / `db:push` / `db:pull`）は使わない。追跡対象が `auth-schema.ts` を含まず、本番D1に対して破壊的な差分（`user`/`session`/`oauth_*` の DROP 等）を提案しうるため、依存ごと削除済み（Issue #23）。
* **破壊的なスキーマ変更（カラム/テーブルの削除・リネーム、NOT NULL 追加等）は expand-and-contract で2段階に分ける**（Issue #24）。deploy command はビルド成功後・デプロイ直前に `db:migrate:remote` を実行するため、適用〜新Worker反映までの短時間は「新スキーマ×旧コード」で動く。旧コードが参照する列を同一デプロイで削除すると、その window で実行時エラーになる。まず参照コードを外すデプロイを出し、次のPRで列/テーブルを削除する。
* マイグレーションはデプロイ時に自動適用される。Cloudflare Workers Builds の各トリガーの deploy command が、ビルド成功後・デプロイ直前に `db:migrate:remote`（本番 `wine`）/ `db:migrate:preview`（プレビュー `wine-preview`）を実行するため、デプロイ前に手動で叩く必要はない。構成の詳細・確認/変更手順は `docs/deployment.md` を参照。
* **スキーマ変更を含むPRは同時に複数オープンしない**（Issue #54）。全プレビュー環境は共通D1（`wine-preview-db`）を共有し、`db:migrate:preview` は適用済みを**ファイル名**で記録する。ブランチAが `0006_foo.sql` を適用済みのところにブランチB（同番号別名の `0006_bar.sql` を持ち foo を知らない）がビルドされると bar も追加適用され、相反する変更なら以後**全ブランチ**の apply が失敗し続ける。マイグレーションは必ず冪等（`IF NOT EXISTS`/`IF EXISTS`）に書き、スキーマ変更PRは1本ずつマージしてから次を出す。共有プレビューDBがブランチ固有の残留や破壊的変更で壊れた場合の作り直し手順は `docs/deployment.md` の「プレビューDBのリセット」を参照。

## PRの作成

* PRには実装プランの内容をdetailsタグで記載してください。
* PRにはTest Planを記載してください。Test Planには、手動での動作確認の手順を記載してください。その後、
### PRのTest Planの動作確認
* PRを作成したら、実際にブラウザで動作確認を行なってください。
* ブラウザでの動作確認中はスクリーンショットを適宜撮影し、Gyazo CLI経由でアップロードしてください。
* 動作確認の完了後は、結果をPRのdescriptionに追記してください。結果には撮影したスクリーンショットのGyazo画像を記載してください。
  * 例: `![aop map](https://i.gyazo.com/c61050ac7cb4454cdaa9525f41810987.png)`

### GitHub MCP はPR本文の一部のマークダウンをサニタイズする

**Claude Code on the web など GitHub MCP 経由でPRを作成・更新すると、本文の一部の記法が落ちる。** 上記2つの規約（detailsタグ・Gyazo画像）がまさに影響を受けるので、書いたつもりでも反映されていないことがある。複数セッションで発生を確認済み（#208 で顕在化）。

* 確認された事象
  * `![alt](url)` の `!` が落ち、**スクリーンショットが画像ではなくリンクとして表示される**
  * `<details>` / `<summary>` が落ち、**実装プランが折りたたまれず展開されたまま表示される**
* **この事象は「本文を書き直して再送」しても直らない**。書き込み側で落ちているため、同じ内容を再度PUTしても結果は同じ。無駄な往復をしないこと。
* **MCPの取得結果（`pull_request_read`）や WebFetch では切り分けられない**。どちらもマークダウンを変換してから返すため、`<img>` が `[alt](url)` に平坦化されて見え、サニタイズされたのか表示上の平坦化なのか区別が付かない。**ブラウザでPRを開いて目視するしかない**。
* 対処: MCP で本文を書いた後、表示形式が要件を満たしているかは人手での確認・貼り直しが必要になる。エージェント側では直せないので、落ちていた場合はその旨をユーザに報告する（黙って放置しない／直せたように書かない）。

### Cloudflare Workersの環境での動作確認
* PR作成後に、Cloudflare Workersの環境が自動で立ち上がります。この環境が作成されたら、上記記載の動作確認をCloudflare Workersの環境で行なってください。
* 実行環境からプレビューURLにブラウザ到達できない場合（プロキシのCONNECT reset / bot保護 Error 1010）は、`verify` skill の「プレビューに到達できない場合の代替手順」に従い、代替した旨と手順をPR本文に明記する。

## 過去PRで繰り返しハマったポイント

過去の全PR（#1〜#186）の振り返りから抽出した頻出の落とし穴。該当する作業では必ず確認する。

* **着手前に重複を確認する**: origin/main を最新化し、同一Issue・機能の既存PR/マージ済みコミットを確認してから実装する（古いmain基点のセッション再開で機能一式2,500行超を丸ごと再実装 → クローズ #61、同一Issueへの並行PRで相互巻き戻しリスク #167/#168）。Issue対応のPR本文には必ず `Closes #N` を書く（auto-close漏れによる「どのIssueが未対応か」の再調査が7本以上のPRで繰り返された）。
* **CIが緑でもランタイムで壊れる変更がある**: バンドラのアセット解決に関わる依存更新や、Node前提の実装がWorkersで無効化するケースは typecheck/build/test では検出できない（maplibre-gl v6 の worker が Vite に検出されず実行時404で地図が真っ白 #184、メモリ保持のレートリミットが isolate 分散でほぼ無効 #178）。この種の変更はプレビュー実機で該当画面を必ず目視する。**CIが網にならない以上、無人マージさせない**のが対の規約で、`vite` / `@vitejs/plugin-react` は Renovate の automerge から外してある（#402）。
* **wrangler と `@cloudflare/vite-plugin` はペアで更新する**: wrangler 単独更新は旧pluginが生成する `dist/server/wrangler.json` の `legacy_env` を新CLIが拒否して deploy が失敗する（#103）。この検証はCIの `bun run check:deploy` / `check:deploy:preview`（本番/preview 両envの `wrangler deploy --dry-run`）で自動化済み。Renovate 側も両パッケージ（＋`@cloudflare/vitest-pool-workers`）を1グループにまとめ automerge から除外してある（#263）ので、この組み合わせのPRは必ず人手でレビューする。automerge に残っている devDependencies も、公開から3日経つまでは着地しない（`minimumReleaseAge`。侵害されたリリースが無人で main に乗る窓を狭める #402）。
* **Workers AI のモデル追加・切替・呼び出し変更**は `workers-ai` skill のチェックリストに従う（`AiModels` 型未登録モデルは呼べない、`guided_json` は型を保証しない、reasoningモデルの thinking で出力が途切れる等。#100/#103/#106/#108/#110 で反復）。
* **横断的な防御・規約は共通チョークポイント（SSOT）に寄せる**: ログ/エラー型/画像MIME検証/認可ガード/フォーム仕様を経路ごとに書くと、後発の経路で必ず適用漏れする（MIME検証がワイン写真経路に未適用 #174、adminガード条件が beforeLoad×3 と middleware でドリフト #177、MCP Appフォーム仕様の5重実装で photo_urls 対応漏れ #185、構造化ログが新ドメイン群で未適用 #166）。新しい入出力経路を足すときは既存の関門を通し、同種の定義が2箇所以上に現れたらSSOT化する。
* **金銭・クレジットの書き込みは既存イディオム以外の形を新設しない**: `db.batch` 原子化 + `requestId` 冪等（UPDATE側にも `NOT EXISTS(request_id)` ガード）+ 条件付きUPDATE + 月境界ガード（docs/architecture.md 参照）。この形から外れた書き込みの原子性・冪等性欠落の修正が #165〜#168/#173 に集中した（settle と refund の requestId が別キーだと unique 制約が二重返金を防げない等）。
* **Stripe 決済の実機確認には自動化不可領域がある**: Checkout のカード入力・Billing Portal（closed shadow DOM）はブラウザ自動化できない → Test Plan に手動確認依頼を明記する。固定ドメイン前提の経路（Checkout 戻りURL・webhook）はブランチプレビューでは404になり、マージ後にしか検証できない（#59/#70）。
* **クイズの出題キュー・完了判定の変更時**は「小スコープ（AOP単位の数問）で最後の未正解をスキップ/不正解にする」「取得結果が全てセッション内正解済み」のケースを必ず確認する（「問題を準備中…」固着が #76 → #169 と経路を変えて再発。escape hatch を外さない）。
* **生産者・格付け・受賞データの追加は出典を必ず一次情報で確認する**（`producer-data` skill のチェックリストに従う）。#203 の一連のPRで、確認して初めて分かった誤りが繰り返し出た。**件数の記述と実際の列挙数が食い違う**（サンテミリオンGCCは「66/62」と書かれて実際は71 #219、トレ・ビッキエーリのトスカーナは「94」で実際は93 #215）。**Wikipedia が古い版のことがある**（クリュ・ブルジョワは2020年版で、2025年版とは14件中8件が別物 #220）。**格付けリストの銘柄が現存しないことがある**（La Gaffelière は2022年に離脱 #216、Laville/La Tour Haut-Brion は2008/2004年に消滅 #218）。誤りは `aop-classification` クイズ経由で利用者に誤った事実を教えることになる。
* **格付けを足すときは件数だけでなく顔ぶれを固定するテストを書く**: `La Gaffelière`（離脱済み）が第1特別級Bに混ざり `La Mondotte` が欠けていた不具合は、**件数が12件で合っていたため**既存の件数スナップショットを素通りした（#216）。`data-integrity.test.ts` の「サンテミリオン第1特別級は公式の顔ぶれと一致する」等が回帰防止。

# 環境

* 本番: https://wine.nibo.sh 。プレビュー: PR作成後に自動で立ち上がり、URLはPRのコメントに記載される。全プレビュー環境が共通のD1（`wine-preview-db`）を共有するため、あるプレビューで作成したデータは他のプレビューからも見える。構成の詳細は `docs/deployment.md` の「環境」を参照。
* ログイン等で origin を検証するため、公開ドメインを追加/変更したら `src/lib/auth.ts` の `trustedOrigins` にも登録すること。
