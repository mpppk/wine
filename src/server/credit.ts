import { createServerFn } from "@tanstack/react-start";
import * as creditService from "#/lib/services/credit-service";
import { optionalAuthMiddleware } from "./middleware";

export interface CreditBalanceStatus {
	authenticated: boolean;
	/** 現在残高(表示クレジット)。未ログインは null(UIで非表示にする)。 */
	balance: number | null;
	/** 残高が属する付与月 "YYYY-MM"(JST)。未ログインは null。 */
	periodMonth: string | null;
}

// クレジット残高のRPC。未ログインでもフラッシュ無しで扱えるよう authenticated を返す。認証任意。
export const getCreditBalance = createServerFn({ method: "GET" })
	.middleware([optionalAuthMiddleware])
	.handler(async ({ context }): Promise<CreditBalanceStatus> => {
		if (!context.user) {
			return { authenticated: false, balance: null, periodMonth: null };
		}
		const b = await creditService.getBalance(context.user.id);
		return {
			authenticated: true,
			balance: b.balance,
			periodMonth: b.periodMonth,
		};
	});
