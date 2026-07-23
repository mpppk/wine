// 管理画面で共有するドメインラベル辞書。値の単一情報源をここに置き、
// 一覧(admin.index)・詳細(admin.$userId)の双方から参照してドリフトを防ぐ
// (クレジット種別は credit/types、監査 action は admin/audit に既存の SSOT がある)。

/** Stripe サブスクリプションの status → 日本語ラベル。 */
export const SUBSCRIPTION_STATUS_LABELS_JA: Record<string, string> = {
	active: "有効",
	trialing: "トライアル中",
	canceled: "解約済み",
	incomplete: "未完了",
	incomplete_expired: "未完了(期限切れ)",
	past_due: "支払い遅延",
	unpaid: "未払い",
	paused: "一時停止",
};

/** サブスク status を日本語ラベルに整形する。未知の値はそのまま、未設定は "-"。 */
export function subscriptionStatusLabel(
	status: string | null | undefined,
): string {
	if (!status) return "-";
	return SUBSCRIPTION_STATUS_LABELS_JA[status] ?? status;
}
