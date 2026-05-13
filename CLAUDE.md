# CLAUDE.md

## プロジェクト概要

TanStack Start、Drizzle ORM、Cloudflare D1 で構築された TODO アプリ。

## 開発コマンド

```bash
bun install          # 依存関係インストール
bun --bun run dev    # 開発サーバー起動 (localhost:3000)
bun --bun run build  # プロダクションビルド
bun --bun run test   # テスト実行
bun --bun run lint   # Biome リント
bun --bun run check  # Biome リント＋フォーマット確認
```

## PR プレビュー環境での動作確認

PR を作成すると Cloudflare Workers Builds が自動的にプレビュー環境をデプロイし、GitHub PR のコメントにプレビュー URL を投稿する。実装内容の動作確認はこのプレビュー URL を使ってブラウザで行うこと。

### 手順

1. ブランチをプッシュして PR を作成する（未作成の場合）
2. `mcp__github__pull_request_read` で PR のコメント一覧を取得し、Cloudflare Workers Builds が投稿したプレビュー URL を見つける
3. `WebFetch` でそのプレビュー URL にアクセスし、実装内容が正しく動作しているか確認する
4. 確認結果をユーザーに報告する

### 注意事項

- プレビューデプロイには数分かかる場合がある。コメントが見つからない場合は少し待ってから再試行する
- D1 データベースのマイグレーションがプレビュー環境に適用されているか確認が必要な場合は `bun run db:migrate:preview` を実行する
- プレビュー URL は `*.workers.dev` または Cloudflare Pages のドメインで提供される
