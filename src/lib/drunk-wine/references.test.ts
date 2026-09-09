import { describe, expect, it } from "vitest";
import {
	storedMarketPricesInput,
	storedReferenceLinksInput,
} from "./reference-inputs";
import {
	mergeStoredMarketPrices,
	mergeStoredReferenceLinks,
	normalizeStoredMarketPrices,
	normalizeStoredReferenceLinks,
	STORED_MARKET_PRICES_MAX,
	STORED_REFERENCE_LINKS_MAX,
} from "./references";

// 解析の参考サイト・市場価格の保存用SSOT。DB列の追加は別PRのため、ここでは
// API境界の形・正規化・統合の純ロジックだけを固定する。

describe("normalizeStoredMarketPrices", () => {
	it("外貨の金額を原通貨のまま残す($20 の回帰)", () => {
		expect(
			normalizeStoredMarketPrices([
				{
					source: "Wine Enthusiast",
					currency: "USD",
					amount: 20,
					url: "https://www.wineenthusiast.com/buying-guide/aaa",
				},
			]),
		).toEqual([
			{
				source: "Wine Enthusiast",
				currency: "USD",
				amount: 20,
				url: "https://www.wineenthusiast.com/buying-guide/aaa",
			},
		]);
	});

	it("モデルの生出力(snake_case)も受ける", () => {
		expect(
			normalizeStoredMarketPrices([
				{
					source: "aaa.com",
					amount_jpy: 2000,
					currency: null,
					amount: null,
					url: null,
				},
			]),
		).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
	});

	it("金額が読めない行・source が無い行は落とす", () => {
		expect(
			normalizeStoredMarketPrices([
				{ source: "店頭" },
				{ source: null, amountJpy: 1000 },
				{ source: "bbb.com", amountJpy: 3000 },
			]),
		).toEqual([{ source: "bbb.com", amountJpy: 3000 }]);
	});

	it("URLが読めなくても行は残す(価格そのものが情報のため)", () => {
		expect(
			normalizeStoredMarketPrices([
				{ source: "ccc.com", amountJpy: 1000, url: "not a url" },
			]),
		).toEqual([{ source: "ccc.com", amountJpy: 1000 }]);
	});

	it("上限を超えたぶんは切り捨てる", () => {
		const input = Array.from(
			{ length: STORED_MARKET_PRICES_MAX + 2 },
			(_, i) => ({ source: `s${i}.com`, amountJpy: 1000 + i }),
		);
		expect(normalizeStoredMarketPrices(input)).toHaveLength(
			STORED_MARKET_PRICES_MAX,
		);
	});
});

describe("normalizeStoredReferenceLinks", () => {
	it("http/https の行だけ残す", () => {
		expect(
			normalizeStoredReferenceLinks([
				{ title: "公式", url: "https://example.com/a" },
				{ title: "x", url: "javascript:alert(1)" },
				{ title: "y", url: null },
			]),
		).toEqual([{ title: "公式", url: "https://example.com/a" }]);
	});

	it("同じURLの重複を潰し、上限で切り捨てる", () => {
		const input = Array.from(
			{ length: STORED_REFERENCE_LINKS_MAX + 2 },
			(_, i) => ({ url: `https://example.com/${i}` }),
		);
		const dup = [...input, { url: "https://example.com/0" }];
		expect(normalizeStoredReferenceLinks(dup)).toHaveLength(
			STORED_REFERENCE_LINKS_MAX,
		);
	});
});

describe("mergeStoredMarketPrices / mergeStoredReferenceLinks", () => {
	it("どちらも空なら undefined(空配列を持ち回さない)", () => {
		expect(mergeStoredMarketPrices(undefined, undefined)).toBeUndefined();
		expect(mergeStoredMarketPrices([], [])).toBeUndefined();
		expect(mergeStoredReferenceLinks(undefined, [])).toBeUndefined();
	});

	it("同じ店・同じ金額の重複を潰して束ねる", () => {
		expect(
			mergeStoredMarketPrices(
				[{ source: "aaa.com", amountJpy: 2000 }],
				[
					{ source: "aaa.com", amountJpy: 2000 },
					{ source: "bbb.com", currency: "USD", amount: 20 },
				],
			),
		).toEqual([
			{ source: "aaa.com", amountJpy: 2000 },
			{ source: "bbb.com", currency: "USD", amount: 20 },
		]);
	});

	it("同じURLの参考サイトを重複させない", () => {
		expect(
			mergeStoredReferenceLinks(
				[{ url: "https://example.com/a" }],
				[{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
			),
		).toEqual([
			{ url: "https://example.com/a" },
			{ url: "https://example.com/b" },
		]);
	});
});

describe("stored input schemas", () => {
	it("アプリ側の表現を受け付ける", () => {
		expect(
			storedMarketPricesInput.safeParse([
				{ source: "aaa.com", amountJpy: 2000 },
			]).success,
		).toBe(true);
		expect(
			storedReferenceLinksInput.safeParse([
				{ title: "公式", url: "https://example.com/a" },
			]).success,
		).toBe(true);
	});

	it("11件以上は受け付けない(正規化の上限3件より手前で弾く)", () => {
		const prices = Array.from({ length: 11 }, (_, i) => ({
			source: `s${i}.com`,
			amountJpy: 1000,
		}));
		expect(storedMarketPricesInput.safeParse(prices).success).toBe(false);
	});
});
