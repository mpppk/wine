// `wrangler secret put` / `.dev.vars` で渡すシークレットは `wrangler types` の
// 生成対象外(worker-configuration.d.ts に現れない)ため、ここで Env に補完する。
declare namespace Cloudflare {
	interface Env {
		// better-auth のセッションCookie署名・OAuthトークン生成に使う必須シークレット。
		// 本番/プレビューは `wrangler secret put BETTER_AUTH_SECRET`、ローカルは
		// `.dev.vars` で設定する(未設定だと better-auth は既定値へフォールバックし、
		// NODE_ENV=production では起動時に fail-fast する)。
		BETTER_AUTH_SECRET?: string;
		STRIPE_SECRET_KEY?: string;
		STRIPE_WEBHOOK_SECRET?: string;
		// 既存プレミアム会員の期間延長キャンペーンコード。"CODE=days" をカンマ区切り。
		// 推測による悪用を防ぐためシークレット扱い(wrangler secret put で投入)。
		CAMPAIGN_EXTENSION_CODES?: string;
	}
}
