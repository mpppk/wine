ワインのAOP(原産地呼称)を地図で学ぶWebアプリ。TanStack Start + MapLibre GL JS + Cloudflare Workers/D1。

公開URL: https://wine.nibo.sh (カスタムドメイン)。Workers のデフォルトドメイン https://wine.niboshi.workers.dev でも動作する。

- ディレクトリ構成・アーキテクチャ・ドメインモデリングのルール: [docs/architecture.md](./docs/architecture.md)
- デプロイ・環境構成: [docs/deployment.md](./docs/deployment.md)

## AOP境界データの生成

`public/data/aop/*.geojson` は INAO / EU PDO のオープンデータから生成する(生成物はコミット済み。データ更新時のみ再実行)。手順・データソース・再生成時の注意は [docs/geodata.md](./docs/geodata.md) を参照。

AOPのメタデータ(土壌・品種・生産者)は `src/lib/wine/aops.json` にあり、`src/lib/wine/aop-schema.ts` のスキーマで読み込み時に検証される。

# Getting Started

To run this application:

```bash
bun install
bun --bun run dev
```

# Building For Production

To build this application for production:

```bash
bun --bun run build
```

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
bun --bun run test
```

## Setting up Cloudflare D1

This app uses Cloudflare D1 (the `DB` binding in `wrangler.jsonc`) to persist Better Auth data (users / sessions / OAuth clients).

Create the D1 database:

```bash
bunx --bun wrangler d1 create wine-db
```

Copy the generated `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`, then regenerate Worker binding types:

```bash
bun run cf-typegen
```

For Drizzle Kit remote operations, set these values in `.env.local`:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_DATABASE_ID=your-d1-database-id
CLOUDFLARE_D1_TOKEN=your-api-token
```

Generate and apply local D1 migrations:

```bash
bun run db:generate
bun run db:migrate:local
```

Apply migrations to the remote D1 database after the real `database_id` is configured:

```bash
bun run db:migrate:remote
```

## Linting & Formatting

This project uses [Biome](https://biomejs.dev/) for linting and formatting. The following scripts are available:

```bash
bun --bun run lint
bun --bun run format
bun --bun run check
```

## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpm dlx shadcn@latest add button
```

## Better Auth

Authentication is handled by [Better Auth](https://www.better-auth.com). Set the `BETTER_AUTH_SECRET` environment variable in your `.env.local`:

```bash
bunx --bun @better-auth/cli secret
```

For local OAuth/MCP verification, also set `BETTER_AUTH_URL=http://localhost:3000` in `.dev.vars` (see `.dev.vars.example`).
