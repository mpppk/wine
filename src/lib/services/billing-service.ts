import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { subscription } from "#/db/auth-schema";
import { ENTITLED_STATUSES, resolvePlan } from "#/lib/billing/entitlements";

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
