import { describe, expect, it } from "vitest";
import {
	APPELLATION_SEARCH_LIMIT,
	getAppellationDetail,
	lookupProducer,
	searchAppellations,
} from "./label-tool-logic";

// エージェントループがモデルへ露出するツールの中身。**指示文にAOP全名称(516件・
// 約4,900トークン)を同梱する代わり**に必要な数件だけを引かせるためのもので、
// ループでは入力が毎ターン再送されるぶん効きが大きい。

describe("searchAppellations", () => {
	it("完全一致を最上位に返す", () => {
		const hits = searchAppellations("Chablis");
		expect(hits[0]?.id).toBe("chablis");
	});

	it("日本語名でも引ける", () => {
		const hits = searchAppellations("シャブリ");
		expect(hits.map((h) => h.id)).toContain("chablis");
	});

	it("部分一致で候補を並べる(綴りが不確かなときの手がかり)", () => {
		// matchAop は単語境界つきの厳格な一致しか認めないので「該当なし」になるが、
		// こちらは候補を見せるための探索なので緩く拾う。
		const hits = searchAppellations("chambertin");
		expect(hits.length).toBeGreaterThan(1);
		expect(hits.every((h) => h.name.toLowerCase().includes("chambertin"))).toBe(
			true,
		);
	});

	it("格付けタグを日本語ラベルで返す", () => {
		const hit = searchAppellations("Chablis Grand Cru")[0];
		expect(hit?.classifications.length).toBeGreaterThan(0);
	});

	it("件数の上限を守る(入力を膨らませない)", () => {
		// 総称的な語は大量にヒットする
		const hits = searchAppellations("bourgogne");
		expect(hits.length).toBeLessThanOrEqual(APPELLATION_SEARCH_LIMIT);
	});

	it("空文字・空白のみは空配列", () => {
		expect(searchAppellations("")).toEqual([]);
		expect(searchAppellations("   ")).toEqual([]);
	});
});

describe("getAppellationDetail", () => {
	it("許可品種と主要品種を分けて返す(品種の整合を確かめる材料)", () => {
		const detail = getAppellationDetail("chablis-grand-cru");
		expect(detail?.principalGrapes).toContain("Chardonnay");
		expect(detail?.allowedGrapes).toContain("Chardonnay");
	});

	it("地域と国を返す", () => {
		const detail = getAppellationDetail("chablis");
		expect(detail?.regionJa).toBeTruthy();
		expect(detail?.country).toBeTruthy();
	});

	it("未知のidは undefined(ツール側でエラーに変える)", () => {
		expect(getAppellationDetail("no-such-appellation")).toBeUndefined();
	});
});

describe("lookupProducer", () => {
	it("生産者名から呼称を逆引きする", () => {
		// ラベルの呼称が欠けている・読めないときの主要な手がかり(#455)。
		const hits = lookupProducer("Dauvissat");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.appellations.length).toBeGreaterThan(0);
	});

	it("アクセント記号の有無を吸収する", () => {
		const withAccent = lookupProducer("Château");
		const without = lookupProducer("Chateau");
		expect(without.length).toBe(withAccent.length);
		expect(without.length).toBeGreaterThan(0);
	});

	it("同じ生産者が複数の呼称に登録されていても1件にまとめる", () => {
		const hits = lookupProducer("Dauvissat");
		const names = hits.map((h) => h.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("該当が無ければ空配列", () => {
		expect(lookupProducer("この生産者は存在しない")).toEqual([]);
	});

	it("空文字は空配列(全件返さない)", () => {
		expect(lookupProducer("")).toEqual([]);
	});
});
