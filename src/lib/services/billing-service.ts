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
import { BadRequestError, ConflictError } from "#/lib/errors";
import { logError } from "#/lib/logger";

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
 * 有効なプレミアム会員(active/trialing の Stripe サブスク保持者)の Stripe trial_end を
 * days 分だけ後ろ倒しして無償延長する(proration_behavior: none)。プレミアムでなければ throw。
 * DBの periodEnd は webhook で同期される。coupon_redemption 等の記録は呼び出し側の責務。
 * キャンペーンコード引換(redeemExtensionCode)と #114 の管理者による直接延長で共有する。
 */
export async function extendPremiumTrial(
	userId: string,
	days: number,
): Promise<{ newPeriodEnd: number; stripeSubscriptionId: string }> {
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
		// 有効なサブスクが無い状態との衝突(コード引換・管理者延長で共有)。
		throw new ConflictError("プレミアム会員のみご利用いただけます。");
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

	return {
		newPeriodEnd: newTrialEnd * 1000,
		stripeSubscriptionId: activeRow.stripeSubscriptionId,
	};
}

/**
 * キャンペーンコードで既存プレミアム会員の期間を延長する。
 * Stripe プロモコードは Checkout 専用で既存サブスクには使えないため、アプリ側でコードを
 * 検証し、Stripe サブスクの trial_end を延長する(extendPremiumTrial)。
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
		throw new BadRequestError("コードが正しくありません。");
	}
	const code = normalizeCode(rawCode);

	// 引換を「先に」記録して1回性を原子的に確定する(unique 制約
	// coupon_redemption_user_code_uq)。並行リクエストやリトライは、後続の1本が
	// ここで即 unique 違反となり「利用済み」で弾かれるため、Stripe 延長は最大1回に限定
	// される(check-then-act で両方が Stripe 延長を実行する事故を防ぐ・#145)。
	try {
		await db.insert(couponRedemption).values({
			id: crypto.randomUUID(),
			userId,
			code,
			extendedDays: days,
		});
	} catch (_e) {
		throw new ConflictError("このコードは既に利用済みです。");
	}

	// 記録確定後に Stripe を延長する。延長に失敗したら、記録した引換行を打ち消して
	// (補償)整合を保つ。リトライ時に再度引換できるようにするためでもある。
	try {
		const { newPeriodEnd } = await extendPremiumTrial(userId, days);
		return { extendedDays: days, newPeriodEnd };
	} catch (e) {
		await db
			.delete(couponRedemption)
			.where(
				and(
					eq(couponRedemption.userId, userId),
					eq(couponRedemption.code, code),
				),
			);
		logError("extension code redemption rolled back after stripe failure", {
			userId,
			code,
			err: e,
		});
		throw e;
	}
}
