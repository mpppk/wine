ワインのAOP(原産地呼称)を地図で学ぶWebアプリ。TanStack Start + MapLibre GL JS + Cloudflare Workers/D1。

公開URL: https://wine.nibo.sh (カスタムドメイン)。Workers のデフォルトドメイン https://wine.niboshi.workers.dev でも動作する。ログインなどで origin を検証するため、新しいドメインを追加する場合は `src/lib/auth.ts` の `trustedOrigins` にも登録すること。

## AOP境界データの生成

`public/data/aop/*.geojson` は INAO のオープンデータから生成する(生成物はコミット済み。データ更新時のみ再実行):

```bash
bun run build:geodata
```

- 村名/グラン・クリュ: INAO「Délimitation parcellaire des AOC viticoles」(data.gouv.fr、約270MBのShapefileを自動ダウンロードして `.cache/` にキャッシュ)
- 広域AOC: INAO「Aires géographiques des AOC/AOP」CSV × geo.api.gouv.fr のコミューン輪郭
- 実行後に表示される bounds を `src/lib/wine/regions.ts` に反映する

### イタリア(ピエモンテ)

イタリアには公式の区画GISが存在しないため、別データソース・別スクリプトで生成する:

```bash
bun run build:geodata:italy            # figshareからgpkgをDL(キャッシュ)
bun run build:geodata:italy -- --source /path/to/EU_PDO.gpkg   # ローカル指定も可
```

- 出典: Candiago, S. et al. "A geospatial inventory of regulatory information for wine
  protected designations of origin in Europe." *Sci Data* 9, 394 (2022).
  figshare `doi:10.6084/m9.figshare.19312094`(EU_PDO.gpkg, ライセンス **CC0**)
- 各PDOをコミューン単位で集約した境界(フランスの区画単位より粗い概略値)
- `PDOid` と `aops.json` の対応は `scripts/build-italy-geodata.mjs` の `PIEMONTE_PDO` 表
- 実行後に表示される bounds を `src/lib/wine/regions.ts` の piemonte に反映する

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

This app uses Cloudflare D1 (the `DB` binding in `wrangler.jsonc`) to persist Better Auth data (users / sessions / OAuth clients) and the app's own domain data (learning progress, cellar records, credit ledger, etc.).

Create the D1 database:

```bash
bunx --bun wrangler d1 create wine-db
```

Copy the generated `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`, then regenerate Worker binding types:

```bash
bun run cf-typegen
```

### Migrations

Migrations are **hand-written sequential SQL** files under `drizzle/` (`0000_*.sql`, `0001_*.sql`, …). Drizzle ORM (`src/db/schema.ts` / `src/db/auth-schema.ts`) is the runtime query layer only — schema changes are authored by hand as the next numbered SQL file and applied with `wrangler d1 migrations apply`. `drizzle-kit` (`db:generate` / `db:push` / `db:pull`) is intentionally **not** used, since its tracking state does not include the Better Auth tables and could propose destructive diffs against the production DB. See `CLAUDE.md` for the schema-change workflow.

Apply migrations to the local D1 (run once initially and after every schema change, before `bun run dev`):

```bash
bun run db:migrate:local
```

Migrations are applied to the remote databases automatically on deploy — Cloudflare Workers Builds runs `db:migrate:remote` / `db:migrate:preview` after a successful build (see `docs/deployment.md`). To apply them manually against the production D1:

```bash
bun run db:migrate:remote
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

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

Authentication is handled by [Better Auth](https://www.better-auth.com). It requires a
`BETTER_AUTH_SECRET` in **every** environment — it signs session cookies and OAuth tokens.
Generate one with:

```bash
bunx --bun @better-auth/cli secret
```

- **Local**: put it in `.dev.vars` as `BETTER_AUTH_SECRET=...` (see `.dev.vars.example`).
- **Production / Preview (Cloudflare Workers)**: set it as a secret so it is never committed:

  ```bash
  bunx --bun wrangler secret put BETTER_AUTH_SECRET
  bunx --bun wrangler secret put BETTER_AUTH_SECRET --env preview
  ```

`wrangler secret put` values are not emitted by `wrangler types`, so the binding is declared
for TypeScript in `src/env-secrets.d.ts`. If `BETTER_AUTH_SECRET` is missing, Better Auth falls
back to a built-in default and, with `NODE_ENV=production`, fails fast at startup.

For local OAuth/MCP verification, also set `BETTER_AUTH_URL=http://localhost:3000` in `.dev.vars` (see `.dev.vars.example`).

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

## Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
