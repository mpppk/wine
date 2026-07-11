import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { couponRedemption } from "#/db/schema";
import {
	normalizeCode,
	parseCampaignCodes,
	resolveExtensionDays,
} from "#/lib/billing/campaign-codes";
import { ENTITLED_STATUSES, resolvePlan } from "#/lib/billing/entitlements";
import { stripeClient } from "#/lib/billing/stripe-client";

// 会員区分のユーザ状態を扱うサービス層。判定ロジックは
// #/lib/billing/entitlements の純関数に置き、ここはD1アクセスとの薄い橋渡しに徹する。

/** ユーザーが現在プレミアム会員(有効なサブスクリプション保持)か判定する。 */
export async function isPremiumUser(userId: string): Promise<boolean> {
	const rows = await db
		.select({
			status: subscription.status,
			periodEnd: subscription.periodEnd,
		})
		.from(subscription)
		.where(
			and(
				// referenceId は @better-auth/stripe が userId を格納する
				eq(subscription.referenceId, userId),
				inArray(subscription.status, [...ENTITLED_STATUSES]),
			),
		);
	return resolvePlan(rows) === "premium";
}

export interface RedeemExtensionResult {
	/** このコードで延長した日数。 */
	extendedDays: number;
	/** 延長後の次回請求日(ミリ秒)。webhook 反映前でもUIで表示できるよう返す。 */
	newPeriodEnd: number;
}

/**
 * キャンペーンコードで既存プレミアム会員の期間を延長する。
 * Stripe プロモコードは Checkout 専用で既存サブスクには使えないため、アプリ側で
 * コードを検証し、Stripe サブスクの trial_end を「現在の期間終了+日数」に更新して
 * 無償延長する(proration_behavior: none)。DBの periodEnd は webhook で同期される。
 */
export async function redeemExtensionCode(
	userId: string,
	rawCode: string,
): Promise<RedeemExtensionResult> {
	const days = resolveExtensionDays(
		rawCode,
		parseCampaignCodes(env.CAMPAIGN_EXTENSION_CODES),
	);
	if (days === null) {
		throw new Error("コードが正しくありません。");
	}
	const code = normalizeCode(rawCode);

	// 有効なサブスク(active/trialing)と Stripe subscription id を取得する。
	const rows = await db
		.select({
			status: subscription.status,
			periodEnd: subscription.periodEnd,
			stripeSubscriptionId: subscription.stripeSubscriptionId,
		})
		.from(subscription)
		.where(
			and(
				eq(subscription.referenceId, userId),
				inArray(subscription.status, [...ENTITLED_STATUSES]),
			),
		);
	const activeRow = rows.find((r) => r.stripeSubscriptionId);
	if (resolvePlan(rows) !== "premium" || !activeRow?.stripeSubscriptionId) {
		throw new Error("プレミアム会員のみご利用いただけます。");
	}

	// 同一コードの再利用を防ぐ(insert 時の unique 制約でも二重に防御する)。
	const existing = await db
		.select({ id: couponRedemption.id })
		.from(couponRedemption)
		.where(
			and(eq(couponRedemption.userId, userId), eq(couponRedemption.code, code)),
		);
	if (existing.length > 0) {
		throw new Error("このコードは既に利用済みです。");
	}

	// 現在の期間終了を基準に延長する。Stripe(basil API)では current_period_end は
	// Subscription 本体ではなく Subscription Item 側にあるため items から読む。
	const stripeSub = await stripeClient.subscriptions.retrieve(
		activeRow.stripeSubscriptionId,
	);
	const currentPeriodEnd = stripeSub.items.data[0]?.current_period_end;
	if (!currentPeriodEnd) {
		throw new Error("現在の契約期間を取得できませんでした。");
	}
	// trial_end は Unix 秒。既存の期間終了に日数を足して後ろ倒しする。
	const newTrialEnd = currentPeriodEnd + days * 24 * 60 * 60;
	await stripeClient.subscriptions.update(activeRow.stripeSubscriptionId, {
		trial_end: newTrialEnd,
		proration_behavior: "none",
	});

	// 引換を記録する。競合で unique 制約に当たった場合は「利用済み」に読み替える。
	try {
		await db.insert(couponRedemption).values({
			id: crypto.randomUUID(),
			userId,
			code,
			extendedDays: days,
		});
	} catch (_e) {
		throw new Error("このコードは既に利用済みです。");
	}

	return { extendedDays: days, newPeriodEnd: newTrialEnd * 1000 };
}
