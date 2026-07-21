import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as creditService from "#/lib/services/credit-service";
import { authMiddleware, optionalAuthMiddleware } from "./middleware";

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

export type ConsumeCreditsDummyResult =
	| { blocked: true; balance: number; required: number }
	| {
			blocked: false;
			reservedCredits: number;
			actualTokens: number;
			balance: number;
	  };

// ダミー消費RPC。Workers AI 導入前に、予約→(擬似実測)→確定 の台帳フローを実機検証するための
// 開発用エンドポイント。実際のAI推論は行わず、見積トークンを引いて擬似実測分を返却する。認証必須。
export const consumeCreditsDummy = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			estimateTokens: z.number().int().positive().max(100_000).default(2000),
			/** 省略時は見積の6割を擬似実測として使う */
			actualTokens: z.number().int().nonnegative().max(100_000).optional(),
		}),
	)
	.handler(async ({ data, context }): Promise<ConsumeCreditsDummyResult> => {
		const userId = context.user.id;
		const requestId = `dummy:${crypto.randomUUID()}`;
		const res = await creditService.reserveCredits(
			userId,
			data.estimateTokens,
			requestId,
		);
		if (!res.ok) {
			return { blocked: true, balance: res.balance, required: res.required };
		}
		try {
			const actualTokens =
				data.actualTokens ?? Math.round(data.estimateTokens * 0.6);
			await creditService.settleReservation(
				userId,
				requestId,
				res.reservedCredits,
				actualTokens,
			);
			const after = await creditService.getBalance(userId);
			return {
				blocked: false,
				reservedCredits: res.reservedCredits,
				actualTokens,
				balance: after.balance,
			};
		} catch (e) {
			// 確定に失敗したら予約全額を返却して残高を巻き戻す。返却成否はログに残し、
			// 返却自体が失敗しても元の例外 e を伝播する(#158)。
			await creditService.refundReservationOnFailure(
				userId,
				requestId,
				res.reservedCredits,
			);
			throw e;
		}
	});
