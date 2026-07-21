# デプロイ (Cloudflare Workers Builds)

このアプリの CD は **Cloudflare Workers Builds**（GitHub 連携）で行う。`mpppk/wine` リポジトリに
2 つの Worker が接続されている。

## 環境

| Worker | 用途 | URL | D1 | R2 |
|---|---|---|---|---|
| `wine` | 本番 | https://wine.nibo.sh （カスタムドメイン。https://wine.niboshi.workers.dev でも可） | `wine-db` | `avatars-wine` |
| `wine-preview` | プレビュー（PRごと / main のミラー） | `https://<branch>-wine-preview.niboshi.workers.dev`（PR作成後に自動発行。URLはPRコメントに記載） | `wine-preview-db`（プレビュー共通） | `avatars-wine-preview`（プレビュー共通） |

- プレビューの D1/R2 は全PRで共有されるため、あるプレビュー環境で作成したデータは他のプレビュー環境からも見える。また PR に含まれるマイグレーションは、マージ前でもプレビュー共通DBへ先行適用される。
- ログイン等で origin を検証するため、公開ドメインを追加/変更したら `src/lib/auth.ts` の `trustedOrigins` にも登録する（プレビューはダッシュ連結ホスト名 `https://*-wine-preview.niboshi.workers.dev` 用のワイルドカードが別途必要）。

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
