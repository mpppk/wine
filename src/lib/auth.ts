import { env } from "cloudflare:workers";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, mcp } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as authSchema from "#/db/auth-schema";
import { PREMIUM_PLAN_NAME, PREMIUM_TRIAL_DAYS } from "#/lib/billing/plans";
import { stripeClient } from "#/lib/billing/stripe-client";
import { logError, logInfo, logWarn } from "#/lib/logger";

// サブスク状態(status/periodEnd)の D1 同期は Stripe webhook(/api/auth/stripe/webhook)が
// 唯一の経路。シークレット未設定だと全 webhook が署名検証で落ち続け、決済してもプレミアムが
// 反映されない事故につながるため、起動パスで1度だけ警告する(#157)。|| "" のフォールバックは
// サインアップを Stripe 設定に依存させない既存方針のため維持する。
if (!env.STRIPE_WEBHOOK_SECRET) {
	logWarn(
		"STRIPE_WEBHOOK_SECRET is not set; Stripe webhooks will fail signature verification and subscription state will not sync",
	);
}

export const auth = betterAuth({
	database: drizzleAdapter(drizzle(env.DB), {
		provider: "sqlite",
		schema: authSchema,
	}),
	// better-auth 内部の warn/error を logger.ts の構造化1行JSONへ流し、Workers Logs で
	// 他のアプリログと同じ形式で検索できるようにする(#157)。info/debug は多いため warn 以上のみ。
	logger: {
		level: "warn",
		log: (level, message, ...args) => {
			const fields = args.length > 0 ? { args } : {};
			if (level === "error") logError(`better-auth: ${message}`, fields);
			else logWarn(`better-auth: ${message}`, fields);
		},
	},
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
	// user テーブルの独自カラム。better-auth に宣言することで getSession /
	// updateUser / useSession が本フィールドを読み書きできる(物理カラムは
	// drizzle/0012_user_preferred_ai_model.sql で追加)。
	user: {
		additionalFields: {
			// 地域Q&Aチャットのモデル選択(プロフィール画面で変更)。input:true で
			// クライアントの updateUser から設定可能にする。値の妥当性はサーバ側で検証。
			preferredAiModel: { type: "string", required: false, input: true },
		},
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
				// webhook 経由のサブスク同期の受信・処理結果をアプリログに残す。決済完了→
				// プレミアム反映、解約→D1反映といった課金イベントの成否を Workers Logs から
				// userId(referenceId)・subscriptionId・status で追跡できるようにする(#157)。
				onSubscriptionComplete: async ({ subscription, plan }) => {
					logInfo("stripe subscription complete", {
						userId: subscription.referenceId,
						stripeSubscriptionId: subscription.stripeSubscriptionId,
						status: subscription.status,
						plan: plan.name,
					});
				},
				onSubscriptionUpdate: async ({ subscription }) => {
					logInfo("stripe subscription updated", {
						userId: subscription.referenceId,
						stripeSubscriptionId: subscription.stripeSubscriptionId,
						status: subscription.status,
					});
				},
				onSubscriptionCancel: async ({ subscription }) => {
					logInfo("stripe subscription canceled", {
						userId: subscription.referenceId,
						stripeSubscriptionId: subscription.stripeSubscriptionId,
						status: subscription.status,
					});
				},
				plans: [
					{
						name: PREMIUM_PLAN_NAME,
						priceId: env.STRIPE_PRICE_ID_MONTHLY || "",
						// 年間契約は月額10ヶ月分(2ヶ月分お得)の別 Price を割り当てる。
						annualDiscountPriceId: env.STRIPE_PRICE_ID_ANNUAL || "",
						// 全新規会員に一律の無料トライアルを付与する。プラグインが
						// Checkout に trial_period_days を渡し、trialing の間も
						// ENTITLED_STATUSES に含まれるためプレミアム扱いになる。
						freeTrial: {
							days: PREMIUM_TRIAL_DAYS,
						},
					},
				],
				// Checkout に Stripe 標準のプロモコード入力欄を出す。割引クーポン/
				// プロモコード自体は Stripe(Terraform 管理)側で発行し、ユーザが
				// ここで入力して適用する。discounts は指定しない(プロモコード欄と排他)。
				getCheckoutSessionParams: () => ({
					params: {
						allow_promotion_codes: true,
					},
				}),
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
		// 管理画面(ユーザ管理)用。role="admin" のユーザのみ管理APIを利用可能。
		// 初回の admin 付与は wrangler d1 execute の手動 UPDATE で行う(PR参照)。
		admin({
			defaultRole: "user",
			adminRoles: ["admin"],
			bannedUserMessage: "このアカウントは利用停止されています。",
		}),
		// The cookie integration must be last so Set-Cookie headers from the
		// plugins above (e.g. the mcp consent flow) are forwarded to TanStack.
		tanstackStartCookies(),
	],
});
