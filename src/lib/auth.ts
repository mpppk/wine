import { env } from "cloudflare:workers";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import Stripe from "stripe";
import * as authSchema from "#/db/auth-schema";
import { PREMIUM_PLAN_NAME } from "#/lib/billing/plans";

// Stripe キー未設定でもアプリが起動するようプレースホルダで初期化する。
// Stripe API 呼び出し時に初めて失敗するので、ログイン等の既存機能には影響しない
// (ローカル開発・CI ビルドは未設定で動く前提)。
const stripeClient = new Stripe(
	env.STRIPE_SECRET_KEY || "sk_test_placeholder",
	{
		// Workers では Node の http エージェントではなく fetch ベースのクライアントを使う。
		httpClient: Stripe.createFetchHttpClient(),
	},
);

export const auth = betterAuth({
	database: drizzleAdapter(drizzle(env.DB), {
		provider: "sqlite",
		schema: authSchema,
	}),
	trustedOrigins: [
		"http://localhost:3000",
		"http://localhost:3001",
		// カスタムドメイン(本番公開用)。
		"https://wine.nibo.sh",
		"https://wine.niboshi.workers.dev",
		"https://*.wine.niboshi.workers.dev",
		// wrangler の versions preview / Workers Builds のプレビューURLは
		// 「<version|branch>-<worker名>.niboshi.workers.dev」というダッシュ連結の
		// ホスト名になるため、ドット区切りのワイルドカードとは別に許可する。
		"https://*-wine.niboshi.workers.dev",
		"https://wine-preview.niboshi.workers.dev",
		"https://*-wine-preview.niboshi.workers.dev",
	],
	emailAndPassword: {
		enabled: true,
	},
	plugins: [
		// プレミアム会員(月額/年額)のサブスクリプション課金。
		// webhook は better-auth ハンドラ経由で /api/auth/stripe/webhook が受ける。
		stripe({
			stripeClient,
			stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
			// サインアップを Stripe の可用性・設定有無に依存させない。
			// Stripe 顧客は初回アップグレード時に自動作成される。
			createCustomerOnSignUp: false,
			subscription: {
				enabled: true,
				plans: [
					{
						name: PREMIUM_PLAN_NAME,
						priceId: env.STRIPE_PRICE_ID_MONTHLY || "",
						// 年間契約は月額10ヶ月分(2ヶ月分お得)の別 Price を割り当てる。
						annualDiscountPriceId: env.STRIPE_PRICE_ID_ANNUAL || "",
					},
				],
			},
		}),
		// OAuth 2.1 provider for MCP clients (Claude Code / Desktop etc.).
		mcp({
			loginPage: "/login",
			oidcConfig: {
				loginPage: "/login",
				consentPage: "/oauth/consent",
				// MCP clients register themselves via RFC 7591 dynamic registration.
				allowDynamicClientRegistration: true,
			},
		}),
		// The cookie integration must be last so Set-Cookie headers from the
		// plugins above (e.g. the mcp consent flow) are forwarded to TanStack.
		tanstackStartCookies(),
	],
});
