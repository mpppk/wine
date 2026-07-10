import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import {
	type BillingFetchState,
	shouldShowAds,
} from "#/lib/billing/entitlements";
import { getBillingStatus } from "#/server/billing";

export const BILLING_STATUS_QUERY_KEY = ["billing-status"] as const;

/** 現在のユーザーの課金ステータス(無料/プレミアム)を取得する。 */
export function useBillingStatus() {
	return useQuery({
		queryKey: BILLING_STATUS_QUERY_KEY,
		queryFn: () => getBillingStatus(),
		staleTime: 60_000,
	});
}

/** プレミアム会員なら true。未ログイン・取得中・取得失敗は false。 */
export function useIsPremium(): boolean {
	const { data } = useBillingStatus();
	return data?.isPremium ?? false;
}

/**
 * このユーザーに広告を表示すべきなら true(広告UI自体は今後導入予定)。
 * 判定ルールは entitlements.ts の shouldShowAds を参照。
 */
export function useShowAds(): boolean {
	const { pathname } = useLocation();
	const query = useBillingStatus();
	const billing: BillingFetchState = query.isPending
		? { kind: "loading" }
		: query.isError
			? { kind: "error" }
			: { kind: "success", isPremium: query.data.isPremium };
	return shouldShowAds({ pathname, billing });
}
