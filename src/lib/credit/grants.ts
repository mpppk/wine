import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";

/** プランに応じた毎月の付与クレジット数を返す。無料 < プレミアム。 */
export function monthlyGrantForPlan(isPremium: boolean): number {
	return isPremium ? MONTHLY_CREDITS_PREMIUM : MONTHLY_CREDITS_FREE;
}
