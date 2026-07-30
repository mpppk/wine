import { createServerFn } from "@tanstack/react-start";
import type { AffiliateConfig } from "#/lib/wine/affiliate";
import { buildAffiliateConfig } from "#/lib/wine/affiliate-env";

// アフィリエイトIDは Cloudflare Workers のランタイム環境変数(wrangler.jsonc の vars、
// または `wrangler secret put` で設定)から供給する。この server fn は常にサーバー側で
// 実行されるため、クライアントへ env を漏らさずに公開IDだけを返せる。
// UI(map / embed ルートの loader)から呼び、AopDetailPanel に渡す。
export const getAffiliateConfig = createServerFn({ method: "GET" }).handler(
	async (): Promise<AffiliateConfig> => buildAffiliateConfig(),
);
