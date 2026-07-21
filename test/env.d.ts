/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

// `cloudflare:test` の env は生成物 worker-configuration.d.ts の `Cloudflare.Env`
// をそのまま公開する(DB/AVATARS/AI/BETTER_AUTH_URL 等は既に定義済み)。
// テスト専用のバインディング TEST_MIGRATIONS(vitest.config.ts で注入)だけを
// 宣言マージで足す。apply-migrations.ts の applyD1Migrations に渡す型になる。
declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
