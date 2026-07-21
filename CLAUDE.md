## ランタイム / 開発コマンド

* このアプリは Cloudflare Workers にデプロイする（ランタイムは Node.js ではない）。ローカルのタスクランナーは Bun を使う。
* マージ前チェック（CIと同一）: `bun run typecheck` / `bun run check` / `bun run build` / `bun run test`
* ローカルDB: 初回・スキーマ変更後は `bun run db:migrate:local` してから `bun run dev`
* OAuth/MCP をローカル検証する場合は `.dev.vars` に `BETTER_AUTH_URL=http://localhost:3000` を設定（`.dev.vars.example` 参照）

## 実装プランの作成

プランの作成時は、検討が必要な項目を徹底的に洗い出し、曖昧性が完全に排除されるまでユーザに質問・確認を行なってください。

## MCPサーバー変更時の動作確認

`src/lib/mcp/` や `src/routes/api/mcp.ts`（OAuth 関連の `src/lib/auth.ts` / `.well-known/*` / `oauth/consent` / 埋め込みビュー `src/routes/embed/`）を変更したら、`mcp-inspector-verify` skill を使い、MCP Inspector で OAuth 接続〜`tools/list`〜`list_aops`（または `show_aop_map`）実行〜（UI に関わる変更は Apps タブでの App 描画）まで実機確認する。結果は PR の Test Plan / 動作確認結果に記載する。

## DBスキーマ変更を含むPR

* マイグレーションは `drizzle/` に連番SQLを手書きで追加する（`drizzle-kit generate` に頼らない。`IF NOT EXISTS` 付き・既存ファイルは書き換えず新しい連番を積む等の規約は `docs/architecture.md` を参照）。テーブル定義はドメインが `src/db/schema.ts`、better-auth 系が `src/db/auth-schema.ts`。better-auth 関連（`user`/`session`/`oauth_*` 等）は better-auth のスキーマ定義と突合する。
* マイグレーションはデプロイ時に自動適用される（Workers Builds の deploy command が `wrangler d1 migrations apply DB` を実行）ため、デプロイ前に手動で叩く必要はない。構成の詳細・確認/変更手順は `docs/deployment.md` を参照。

## PRの作成

* PRには実装プランの内容をdetailsタグで記載してください。
* PRにはTest Planを記載してください。Test Planには、手動での動作確認の手順を記載してください。その後、
### PRのTest Planの動作確認
* PRを作成したら、実際にブラウザで動作確認を行なってください。
* ブラウザでの動作確認中はスクリーンショットを適宜撮影し、Gyazo CLI経由でアップロードしてください。
* 動作確認の完了後は、結果をPRのdescriptionに追記してください。結果には撮影したスクリーンショットのGyazo画像を記載してください。
  * 例: `![aop map](https://i.gyazo.com/c61050ac7cb4454cdaa9525f41810987.png)`

### Cloudflare Workersの環境での動作確認
* PR作成後に、Cloudflare Workersの環境が自動で立ち上がります。この環境が作成されたら、上記記載の動作確認をCloudflare Workersの環境で行なってください。

# 環境

* 本番: https://wine.nibo.sh 。プレビュー: PR作成後に自動で立ち上がり、URLはPRのコメントに記載される。全プレビュー環境が共通のD1（`wine-preview-db`）を共有するため、あるプレビューで作成したデータは他のプレビューからも見える。構成の詳細は `docs/deployment.md` の「環境」を参照。
* ログイン等で origin を検証するため、公開ドメインを追加/変更したら `src/lib/auth.ts` の `trustedOrigins` にも登録すること。
