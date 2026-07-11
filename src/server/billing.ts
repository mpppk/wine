import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PlanId } from "#/lib/billing/entitlements";
import * as billingService from "#/lib/services/billing-service";
import { authMiddleware, optionalAuthMiddleware } from "./middleware";

export interface BillingStatus {
	plan: PlanId;
	isPremium: boolean;
	/** Stripe の設定が揃っているか。false なら購入ボタンを無効化する。 */
	stripeConfigured: boolean;
}

// 課金ステータスのRPC。未ログインは無料会員扱い(広告あり)なので認証任意。
export const getBillingStatus = createServerFn({ method: "GET" })
	.middleware([optionalAuthMiddleware])
	.handler(async ({ context }): Promise<BillingStatus> => {
		const isPremium = context.user
			? await billingService.isPremiumUser(context.user.id)
			: false;
		return {
			plan: isPremium ? "premium" : "free",
			isPremium,
			// webhook secret を欠くと購入後の期間更新・解約が同期されないため、
			// 4変数すべて揃って初めて「設定済み」とする。
			stripeConfigured: Boolean(
				env.STRIPE_SECRET_KEY &&
					env.STRIPE_WEBHOOK_SECRET &&
					env.STRIPE_PRICE_ID_MONTHLY &&
					env.STRIPE_PRICE_ID_ANNUAL,
			),
		};
	});

// 既存プレミアム会員がキャンペーンコードで期間を延長するRPC。認証必須。
export const redeemExtensionCode = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ code: z.string().trim().min(1).max(64) }))
	.handler(({ data, context }) =>
		billingService.redeemExtensionCode(context.user.id, data.code),
	);
