import { useQuery } from "@tanstack/react-query";
import { getCreditBalance } from "#/server/credit";

export const CREDIT_BALANCE_QUERY_KEY = ["credit-balance"] as const;

/** 現在のユーザーのAIクレジット残高を取得する。 */
export function useCreditBalance() {
	return useQuery({
		queryKey: CREDIT_BALANCE_QUERY_KEY,
		queryFn: () => getCreditBalance(),
		staleTime: 30_000,
	});
}

/**
 * ログイン済みで残高が取得できたときのみ数値を返す。未ログイン・取得中・取得失敗は null
 * (残高0の誤表示や、未ログイン時のフラッシュを避けるため)。
 */
export function useCreditBalanceValue(): number | null {
	const { data } = useCreditBalance();
	return data?.authenticated ? data.balance : null;
}
