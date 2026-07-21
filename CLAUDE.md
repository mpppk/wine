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

* マイグレーションは `drizzle/` に**手書きの連番SQL**で追加する（`0000_*.sql`, `0001_*.sql`, …）。`src/db/schema.ts`（ドメインテーブル）と `src/db/auth-schema.ts`（better-auth の `user`/`session`/`account`/`verification`/`oauth_*` と Stripe の `subscription`）は Drizzle ORM の実行時クエリ層であり、スキーマ変更はこれらに合わせて次番のSQLを手書きする。`wrangler d1 migrations apply DB` が連番SQLを適用する。better-auth / Stripe 関連テーブルは各プラグインのスキーマ定義と突合すること。
* `drizzle-kit`（`db:generate` / `db:push` / `db:pull`）は使わない。追跡対象が `auth-schema.ts` を含まず、本番D1に対して破壊的な差分（`user`/`session`/`oauth_*` の DROP 等）を提案しうるため、依存ごと削除済み（Issue #23）。
* **破壊的なスキーマ変更（カラム/テーブルの削除・リネーム、NOT NULL 追加等）は expand-and-contract で2段階に分ける**（Issue #24）。deploy command はビルド成功後・デプロイ直前に `db:migrate:remote` を実行するため、適用〜新Worker反映までの短時間は「新スキーマ×旧コード」で動く。旧コードが参照する列を同一デプロイで削除すると、その window で実行時エラーになる。まず参照コードを外すデプロイを出し、次のPRで列/テーブルを削除する。
* マイグレーションはデプロイ時に自動適用される。Cloudflare Workers Builds の各トリガーの deploy command が、ビルド成功後・デプロイ直前に `db:migrate:remote`（本番 `wine`）/ `db:migrate:preview`（プレビュー `wine-preview`）を実行するため、デプロイ前に手動で叩く必要はない。構成の詳細・確認/変更手順は `docs/deployment.md` を参照。

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
## 本番環境
* URL: https://wine.nibo.sh （カスタムドメイン。Workers のデフォルト https://wine.niboshi.workers.dev でもアクセス可能）
* ログイン等で origin を検証するため、公開ドメインを追加/変更したら `src/lib/auth.ts` の `trustedOrigins` にも登録すること。

## プレビュー環境
プレビュー環境はPR作成後に自動で立ち上がります。URLはPRのコメントに記載されます。
各プレビュー環境は`https://xxx-wine-preview.niboshi.workers.dev`のようなドメインを持ちます。
各プレビュー環境は共通のD1データベース（`wine-preview-db`）を使用します。したがって、あるプレビュー環境で作成されたデータは、他のプレビュー環境からも確認できます。
