import { env } from "cloudflare:workers";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { admin, mcp } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as authSchema from "#/db/auth-schema";
import {
	IMPERSONATION_READONLY_MESSAGE,
	isImpersonatedSession,
	needsImpersonationCheck,
} from "#/lib/admin/impersonation";
import { regionQaModelKeySchema } from "#/lib/ai/config";
import { PREMIUM_PLAN_NAME, PREMIUM_TRIAL_DAYS } from "#/lib/billing/plans";
import { stripeClient } from "#/lib/billing/stripe-client";
import { logError, logInfo, logWarn } from "#/lib/logger";
import {
	cleanupAfterUserDelete,
	cleanupBeforeUserDelete,
} from "#/lib/services/user-deletion-service";

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
			// args 内の Error は logger 側(sanitize)が文字列化するので、ここでは畳まない(#331)。
			const fields = args.length > 0 ? { args } : {};
			// OAuth コールバックの失敗は message が空文字で Error だけを args に渡してくる。
			// そのまま連結すると msg が "better-auth: " になり、どの経路の行か分からなくなる。
			const label = message.trim() === "" ? "(no message)" : message;
			if (level === "error") logError(`better-auth: ${label}`, fields);
			else logWarn(`better-auth: ${label}`, fields);
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
	// レートリミット。better-auth の既定ストレージはインメモリで、多数の isolate に
	// 分散しメモリを共有しない Cloudflare Workers 上ではほぼ効かない(Issue #31)。
	// storage:"database" で D1(rate_limit テーブル / drizzle/0017)にカウンタを永続化し、
	// sign-in/sign-up/change-password/change-email の既定スペシャルルール(10秒3回)と
	// グローバル制限(10秒100回)を全 isolate 横断で有効化する。preview も Workers 実行の
	// ため、本番以外でも効かせるよう enabled を明示する(既定は本番のみ有効)。
	rateLimit: {
		enabled: true,
		storage: "database",
	},
	// レートリミットのキーとなるクライアントIPの解決元(Issue #197)。better-auth の既定は
	// X-Forwarded-For だが、trustedProxies 無しでは「値が単一IPのとき」しか信用しない仕様で、
	// Cloudflare 経由の XFF はクライアント由来の値にエッジが追記してカンマ連結になりうる。
	// 解決に失敗すると全リクエストが no-trusted-ip|<path> という「パスごとの単一バケット」に
	// 集約され、1クライアントが sign-in を10秒に3回叩くだけでその経路が全ユーザに対して閉じる。
	// CF-Connecting-IP はエッジが必ず設定・上書きする単一値のヘッダで偽装できないため、
	// これ1つで解決でき trustedProxies は不要。X-Forwarded-For はクライアントが送れてしまう
	// (=偽装でレートリミットを回避できる)ため信頼しない。
	advanced: {
		ipAddress: {
			ipAddressHeaders: ["cf-connecting-ip"],
		},
	},
	// なりすまし(impersonation)中は better-auth 自身のエンドポイントも書き込みを通さない(#116)。
	//
	// server function と API ルートは各々のミドルウェア/関門で塞いでいるが、
	// `authClient.updateUser` / `subscription.*` / `/delete-user` はそのどちらも通らず
	// better-auth のハンドラ直結で動く(`user.additionalFields` のコメント参照。#256 と
	// 同じ「ハンドラ直結だからアプリ側の検証を通らない」構図)。ここを塞がないと、
	// なりすまし中の管理者が対象ユーザの名前・アバター・サブスクを書き換えられ、
	// 退会させることまでできてしまう。
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			// 判定は #/lib/admin/impersonation に集約(3系統で条件をドリフトさせない)。
			// 読み取り・許可パス(なりすまし終了/サインアウト)はセッションを引かずに抜ける。
			if (!needsImpersonationCheck(ctx.method ?? "GET", ctx.path)) return;
			// サインイン/サインアップ等の未認証 POST では null になり、そのまま通る。
			const session = await getSessionFromCtx(ctx).catch(() => null);
			if (!isImpersonatedSession(session)) return;
			throw new APIError("FORBIDDEN", {
				message: IMPERSONATION_READONLY_MESSAGE,
			});
		}),
	},
	// ユーザ削除時に D1 の外(Stripe・R2)へ残るものを後始末する(#252)。
	//
	// **`user.deleteUser.beforeDelete` ではなくここに置く**。あちらは本人による
	// セルフ退会(`/delete-user`)専用のフックで、admin プラグインの
	// `/admin/remove-user` は internalAdapter.deleteUser を直接呼ぶため発火しない
	// (better-auth の plugins/admin/routes.mjs)。databaseHooks は user モデルの
	// 削除そのものに掛かるので、どちらの経路からでも必ず通る。
	databaseHooks: {
		user: {
			delete: {
				// 失敗したら throw して削除を中止させる。先にユーザを消すと Stripe の
				// サブスクとの紐付け(subscription.referenceId)が失われ、課金だけが残る。
				before: async (user) => {
					await cleanupBeforeUserDelete(user.id);
				},
				after: async (user) => {
					await cleanupAfterUserDelete(user.id);
				},
			},
		},
	},
	// user テーブルの独自カラム。better-auth に宣言することで getSession /
	// updateUser / useSession が本フィールドを読み書きできる(物理カラムは
	// drizzle/0012_user_preferred_ai_model.sql で追加)。
	user: {
		additionalFields: {
			// 地域Q&Aチャットのモデル選択(プロフィール画面で変更)。input:true で
			// クライアントの updateUser から設定可能にする。
			//
			// validator.input は better-auth の parseInputData が sign-up / update-user の
			// 両経路で必ず通す関門で、許可リスト外は 400 で弾かれ D1 に届かない(#256)。
			// これが無いと `authClient.updateUser({ preferredAiModel })` は better-auth の
			// ハンドラ直結でアプリ側 zod を通らないため、認証済みユーザが自分の user 行へ
			// 任意長の文字列を保存できてしまう。読み取り側(resolveModelKey)と同じ
			// スキーマを使い、許可リストを ai/config.ts に一元化する。
			preferredAiModel: {
				type: "string",
				required: false,
				input: true,
				validator: { input: regionQaModelKeySchema },
			},
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
