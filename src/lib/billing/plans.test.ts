import { describe, expect, it } from "vitest";
import {
	formatJpyAmount,
	PREMIUM_PRICING,
	premiumAnnualSavedMonths,
} from "./plans";

// 料金の表示は複数画面に散る(料金ページ・プロフィール・残高不足ダイアログ・広告)。
// 文言に数値を直書きすると、価格改定時に一部の画面だけ旧い案内が残る(#257)。
// 表示に使う導出はここで固定する。

describe("formatJpyAmount", () => {
	it("桁区切りを入れる", () => {
		expect(formatJpyAmount(300)).toBe("300");
		expect(formatJpyAmount(3000)).toBe("3,000");
	});
});

describe("premiumAnnualSavedMonths", () => {
	it("現在の料金では2ヶ月分お得", () => {
		expect(premiumAnnualSavedMonths()).toBe(2);
	});

	it("金額から導出される(定義と一致する)", () => {
		const { monthlyAmount, annualAmount } = PREMIUM_PRICING;
		expect(premiumAnnualSavedMonths()).toBe(
			Math.floor((monthlyAmount * 12 - annualAmount) / monthlyAmount),
		);
	});
});
