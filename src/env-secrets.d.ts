// `wrangler secret put` / `.dev.vars` で渡すシークレットは `wrangler types` の
// 生成対象外(worker-configuration.d.ts に現れない)ため、ここで Env に補完する。
declare namespace Cloudflare {
	interface Env {
		STRIPE_SECRET_KEY?: string;
		STRIPE_WEBHOOK_SECRET?: string;
		// 既存プレミアム会員の期間延長キャンペーンコード。"CODE=days" をカンマ区切り。
		// 推測による悪用を防ぐためシークレット扱い(wrangler secret put で投入)。
		CAMPAIGN_EXTENSION_CODES?: string;
	}
}
