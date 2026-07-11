// `wrangler secret put` / `.dev.vars` で渡すシークレットは `wrangler types` の
// 生成対象外(worker-configuration.d.ts に現れない)ため、ここで Env に補完する。
declare namespace Cloudflare {
	interface Env {
		STRIPE_SECRET_KEY?: string;
		STRIPE_WEBHOOK_SECRET?: string;
	}
}
