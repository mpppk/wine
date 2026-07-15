import { describe, expect, it } from "vitest";
import { TOKENS_PER_CREDIT } from "#/lib/billing/plans";
import { refundCredits, tokensToCredits } from "./credit-math";

describe("tokensToCredits", () => {
	it("0以下は0クレジット", () => {
		expect(tokensToCredits(0)).toBe(0);
		expect(tokensToCredits(-100)).toBe(0);
	});

	it("換算比のちょうど倍数はそのまま割り切れる", () => {
		expect(tokensToCredits(TOKENS_PER_CREDIT)).toBe(1);
		expect(tokensToCredits(TOKENS_PER_CREDIT * 3)).toBe(3);
	});

	it("端数は切り上げる(過小請求を避ける)", () => {
		expect(tokensToCredits(1)).toBe(1);
		expect(tokensToCredits(TOKENS_PER_CREDIT + 1)).toBe(2);
	});
});

describe("refundCredits", () => {
	it("実測0なら予約全額を返却", () => {
		expect(refundCredits(5, 0)).toBe(5);
	});

	it("実測が予約未満なら差分を返却", () => {
		// 予約5クレジット、実測は2クレジット相当 → 3返却
		expect(refundCredits(5, TOKENS_PER_CREDIT * 2)).toBe(3);
	});

	it("実測が予約以上なら返却0(負にならない)", () => {
		expect(refundCredits(2, TOKENS_PER_CREDIT * 2)).toBe(0);
		expect(refundCredits(2, TOKENS_PER_CREDIT * 5)).toBe(0);
	});
});
