// 会員区分(無料/プレミアム)の判定ロジック。DBアクセスを持たない純粋関数として
// 切り出し、サービス層(billing-service)とクライアントフック(use-billing)で共有する。

/** サブスクリプションが有効とみなす Stripe status。 */
export const ENTITLED_STATUSES = ["active", "trialing"] as const;

// webhook が欠落して periodEnd 更新が届かなかった場合のフェイルセーフ。
// 正常時は Stripe が期間更新のたびに periodEnd を延長するので、この猶予を
// 超えて古い periodEnd が残っているのは同期が壊れている状態とみなす。
const PERIOD_END_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionLike {
	status: string | null;
	periodEnd?: Date | null;
}

/** サブスクリプション1件が現時点で有効(プレミアム扱い)か判定する。 */
export function isSubscriptionEntitled(
	sub: SubscriptionLike,
	now: Date = new Date(),
): boolean {
	if (!ENTITLED_STATUSES.includes(sub.status as never)) return false;
	// 解約予約(cancelAtPeriodEnd)中も Stripe は期間終了まで status=active を
	// 維持するため、status 判定だけで「期間内は有効」を満たせる。
	if (
		sub.periodEnd &&
		now.getTime() > sub.periodEnd.getTime() + PERIOD_END_GRACE_MS
	) {
		return false;
	}
	return true;
}

export type PlanId = "free" | "premium";

/** ユーザーの全サブスクリプションから現在のプランを解決する。 */
export function resolvePlan(
	subs: SubscriptionLike[],
	now: Date = new Date(),
): PlanId {
	return subs.some((sub) => isSubscriptionEntitled(sub, now))
		? "premium"
		: "free";
}

/** 課金ステータスの取得状態。クライアントの React Query の状態を写像する。 */
export type BillingFetchState =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "success"; isPremium: boolean };

/**
 * 広告を表示すべきかの判定(広告UI自体は今後導入予定)。
 * - /embed/ 配下(MCP Apps の iframe 埋め込み)には広告を出さない
 * - 取得中は非表示(プレミアム会員に広告が一瞬見える「フラッシュ」を防ぐ)
 * - 取得失敗時は無料会員として扱う(広告あり)
 * - 未ログインは isPremium=false で返ってくるため無料会員と同じ扱い
 */
export function shouldShowAds(input: {
	pathname: string;
	billing: BillingFetchState;
}): boolean {
	const { pathname, billing } = input;
	if (pathname === "/embed" || pathname.startsWith("/embed/")) return false;
	switch (billing.kind) {
		case "loading":
			return false;
		case "error":
			return true;
		case "success":
			return !billing.isPremium;
	}
}
