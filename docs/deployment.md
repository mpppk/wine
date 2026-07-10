# デプロイ (Cloudflare Workers Builds)

このアプリの CD は **Cloudflare Workers Builds**（GitHub 連携）で行う。`mpppk/wine` リポジトリに
2 つの Worker が接続されている。

| Worker | 用途 | デプロイ対象 D1 |
|---|---|---|
| `wine` | 本番 | `wine-db` |
| `wine-preview` | プレビュー（PRごと / main のミラー） | `wine-preview-db`（プレビュー共通） |

## DB マイグレーションの自動実行

マイグレーションは **各トリガーの deploy command で自動実行**する。ビルド（`bun run build`）が
成功した後・デプロイ直前に走るため、ビルド失敗時は DB に一切触れない。手動で
`bun run db:migrate:remote` / `db:migrate:preview` をデプロイ前に叩く運用は不要。

> deploy command 側に置くのは失敗時の安全性のため。build command 側に置くと、マイグレーション適用後に
> ビルドが失敗した場合、DB だけ進んでデプロイされない状態になり得る。

### トリガー設定

Workers Builds の build / deploy command はダッシュボード（Settings > Build）にのみ保存され、
`wrangler.jsonc` などリポジトリのファイルには保存できない。現在の設定は以下。

| Worker | ブランチ | build command | deploy command |
|---|---|---|---|
| `wine` | `main` | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:remote && npx wrangler deploy` |
| `wine-preview` | `main` | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:preview && npx wrangler deploy` |
| `wine-preview` | `*`（`main` 以外） | `bun install --frozen-lockfile && bun run build` | `bun run db:migrate:preview && npx wrangler versions upload` |

- `db:migrate:remote` = `wrangler d1 migrations apply DB --remote`（`wine-db`）
- `db:migrate:preview` = `wrangler d1 migrations apply DB --remote --env preview`（`wine-preview-db`）
- マイグレーションは冪等（適用済みの連番 SQL はスキップ）なので、プレビュー共通 DB に複数トリガーから
  適用されても問題ない。

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
```

> 設定変更は「次回以降のビルド」に適用される。既存の実行中ビルドには影響しない。
