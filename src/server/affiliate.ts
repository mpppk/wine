import { createServerFn } from "@tanstack/react-start";
import type { AffiliateConfig } from "#/lib/wine/affiliate";
import { buildAffiliateConfig } from "#/lib/wine/affiliate-env";
import { m } from "#/paraglide/messages.js";
import { getLocale } from "#/paraglide/runtime.js";

// アフィリエイトIDは Cloudflare Workers のランタイム環境変数(wrangler.jsonc の vars、
// または `wrangler secret put` で設定)から供給する。この server fn は常にサーバー側で
// 実行されるため、クライアントへ env を漏らさずに公開IDだけを返せる。
// UI(map / embed ルートの loader)から呼び、AopDetailPanel に渡す。
export const getAffiliateConfig = createServerFn({ method: "GET" }).handler(
	async (): Promise<AffiliateConfig> => buildAffiliateConfig(),
);

// Keep a tiny localized server function in the application graph so the Workers
// integration test can exercise the real Start server-function transport and
// assert the request-scoped Paraglide context at the handler boundary.
export const getLocaleProbe = createServerFn({ method: "GET" }).handler(
	async (): Promise<{ locale: string; label: string }> => ({
		locale: getLocale(),
		label: m.header_locale(),
	}),
);
