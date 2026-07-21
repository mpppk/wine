import { applyD1Migrations, env } from "cloudflare:test";

// workers プロジェクトの setupFile。各テストファイルの実行前に、分離された
// テスト用D1(env.DB)へ drizzle/ の連番マイグレーションを適用してスキーマを用意する。
// マイグレーション本体は vitest.config.ts が readD1Migrations で読み、
// TEST_MIGRATIONS バインディング経由で渡している(workerd 側は fs を持たないため)。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
