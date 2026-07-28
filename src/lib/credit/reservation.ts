// 予約(consume)の requestId から派生する台帳キーの導出。SSOT。
//
// クレジットの消費は「予約 → 確定(settle) / 返却(refund)」の3行で1件を表す。確定・返却の
// 台帳行は予約の requestId に固定の接尾辞を付けたキーを使い、request_id の unique 制約で
// 二重計上を弾く(docs/ai-credit-system.md)。この導出規約は credit-service の書き込み・
// 孤児予約の検出(#246)・マイグレーションの補填SQLが同じものを見る必要があるため、
// 文字列連結を散らさずここに集約する。

/** 確定(settle)台帳の requestId 接尾辞。 */
export const SETTLE_SUFFIX = ":settle";
/** 返却(refund)台帳の requestId 接尾辞。 */
export const REFUND_SUFFIX = ":refund";

/** 予約IDから確定(settle)台帳の requestId を導く。 */
export function settleRequestId(reservationId: string): string {
	return `${reservationId}${SETTLE_SUFFIX}`;
}

/** 予約IDから返却(refund)台帳の requestId を導く。 */
export function refundRequestId(reservationId: string): string {
	return `${reservationId}${REFUND_SUFFIX}`;
}
