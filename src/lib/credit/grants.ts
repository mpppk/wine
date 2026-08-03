import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";

/** プランに応じた毎月の付与クレジット数を返す。無料 < プレミアム。 */
export function monthlyGrantForPlan(isPremium: boolean): number {
	return isPremium ? MONTHLY_CREDITS_PREMIUM : MONTHLY_CREDITS_FREE;
}

// 付与(grant / grant_upgrade)台帳の requestId 導出。SSOT。
//
// 消費側の導出を reservation.ts に集約しているのと同じ理由でここに集める: 単体版
// (ensureCurrentMonthGranted)と一括版(ensureCurrentMonthGrantedMany)が同じキーを
// 組み立てる必要があり、文字列連結が散ると片方だけ規約が変わったときに冪等性が壊れる。

/** 当月のリセット付与(grant)の requestId。月1本に絞るキー。 */
export function grantRequestId(userId: string, month: string): string {
	return `grant:${userId}:${month}`;
}

/**
 * 月途中の差分付与(grant_upgrade)の requestId。
 *
 * **付与目標額 `target` をキーに含める**。`grant_upgrade:{userId}:{month}` 固定だと
 * 同一月に差分付与が1回しか成立せず、「無料↔プレミアムの2値なので月1回で足りる」という
 * 前提に依存していた。#383 が月次付与額を月の途中で引き上げた結果、**増額そのものが
 * 当月の枠を消費**し、その後にプレミアムを購入したユーザへの差分付与が
 * `NOT EXISTS(request_id)` ガードと unique 制約に弾かれて無言で消えた(#387)。
 *
 * target を含めれば「同じ目標額への引き上げは1回だけ」という本来の冪等条件になり、
 * 付与額の変更と昇格が同月に重なっても互いを潰さない。差分は常に
 * `target - 当月の累計付与額` で計算されるため、同じ target での再実行は差分0になり
 * 二重付与にはならない(キーの unique は同時実行の重複だけを弾く)。
 */
export function grantUpgradeRequestId(
	userId: string,
	month: string,
	target: number,
): string {
	return `grant_upgrade:${userId}:${month}:${target}`;
}
