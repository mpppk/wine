import { describe, expect, it } from "vitest";
import {
	listAopBrowseItems,
	listCountryOptions,
	listRegionOptions,
	PROVENANCE_SEARCH_LIMIT,
	provenanceNameJa,
	resolveProvenanceOption,
	searchProvenance,
} from "./provenance";

describe("listCountryOptions / listRegionOptions", () => {
	it("enabled な地域を持つ国だけを最上位に出す", () => {
		const ids = listCountryOptions().map((o) => o.id);
		expect(ids).toContain("france");
		expect(ids).toContain("italy");
	});

	it("国ごとの地域が enabled のみ・所属国と一致する", () => {
		const france = listRegionOptions("france").map((o) => o.id);
		expect(france).toContain("bourgogne");
		expect(france).toContain("bordeaux");
		expect(france).not.toContain("toscana");
		const italy = listRegionOptions("italy").map((o) => o.id);
		expect(italy).toContain("toscana");
		expect(italy).toContain("piemonte");
	});
});

describe("listAopBrowseItems", () => {
	it("コート・ド・ニュイは村の下に畑・クリマが階層順で並ぶ", () => {
		const items = listAopBrowseItems("bourgogne", "cote-de-nuits");
		const ids = items.map((i) => i.option.id);
		// 村(ジュヴレ・シャンベルタン)の後に、その特級畑(シャンベルタン)が続く
		const village = ids.indexOf("gevrey-chambertin");
		const grandCru = ids.indexOf("chambertin");
		expect(village).toBeGreaterThanOrEqual(0);
		expect(grandCru).toBeGreaterThan(village);
		// 深さ: 村=0、村配下の畑=1
		expect(items[village]?.depth).toBe(0);
		expect(items[grandCru]?.depth).toBe(1);
	});

	it("シャブリ地区では傘AOCの下に個別クリマが depth 2 で入れ子になる", () => {
		const items = listAopBrowseItems("bourgogne", "chablis-grand-auxerrois");
		const byId = new Map(items.map((i) => [i.option.id, i]));
		expect(byId.get("chablis-grand-cru")?.depth).toBe(1);
		expect(byId.get("chablis-gc-les-clos")?.depth).toBe(2);
	});

	it("未知の地域・地区は空配列", () => {
		expect(listAopBrowseItems("bourgogne", "no-such-subregion")).toEqual([]);
		expect(listAopBrowseItems("no-such-region", "chianti")).toEqual([]);
	});
});

describe("resolveProvenanceOption", () => {
	it("AOP選択はパンくず(国 > 地域 > 村)付きで解決する", () => {
		const option = resolveProvenanceOption({ aopId: "chambertin" });
		expect(option?.kind).toBe("aop");
		expect(option?.nameJa).toBe("シャンベルタン");
		expect(option?.breadcrumb).toEqual([
			"フランス",
			"ブルゴーニュ",
			"ジュヴレ・シャンベルタン",
		]);
	});

	it("クリマは親畑をパンくずに含める", () => {
		const option = resolveProvenanceOption({ aopId: "chablis-gc-les-clos" });
		expect(option?.breadcrumb).toContain("シャブリ・グラン・クリュ");
	});

	it("地域・国の選択も解決する", () => {
		expect(resolveProvenanceOption({ regionId: "toscana" })?.nameJa).toBe(
			"トスカーナ",
		);
		expect(
			resolveProvenanceOption({ regionId: "toscana" })?.breadcrumb,
		).toEqual(["イタリア"]);
		expect(resolveProvenanceOption({ countryId: "france" })?.nameJa).toBe(
			"フランス",
		);
	});

	it("未選択・未知IDは undefined", () => {
		expect(resolveProvenanceOption({})).toBeUndefined();
		expect(resolveProvenanceOption({ aopId: "no-such-aop" })).toBeUndefined();
	});
});

describe("searchProvenance", () => {
	it("日本語・現地語・アクセント無視で国・地域・AOPを横断検索できる", () => {
		expect(searchProvenance("フランス")[0]?.id).toBe("france");
		expect(searchProvenance("ブルゴーニュ").map((o) => o.id)).toContain(
			"bourgogne",
		);
		// アクセント記号を落として一致する(Juliénas → julienas)
		expect(searchProvenance("julienas").map((o) => o.id)).toContain("julienas");
		expect(searchProvenance("ジュヴレ")[0]?.id).toBe("gevrey-chambertin");
	});

	it("前方一致を部分一致より優先する", () => {
		const results = searchProvenance("シャブリ");
		expect(results[0]?.id).toBe("chablis");
		expect(results.map((o) => o.id)).toContain("chablis-grand-cru");
	});

	it("検索結果は上限件数で打ち切る", () => {
		// 1文字クエリは大量に部分一致する
		expect(searchProvenance("a").length).toBeLessThanOrEqual(
			PROVENANCE_SEARCH_LIMIT,
		);
	});

	it("空クエリ・ヒットなしは空配列", () => {
		expect(searchProvenance("  ")).toEqual([]);
		expect(searchProvenance("zzzzzz")).toEqual([]);
	});
});

describe("provenanceNameJa", () => {
	it("細かい順に AOP名 > 地域名 > 国名で表示名を返す", () => {
		expect(provenanceNameJa({ aopId: "chablis", aopNameJa: "シャブリ" })).toBe(
			"シャブリ",
		);
		// AOP紐付け行は regionId が導出で非nullでも AOP名が勝つ
		expect(
			provenanceNameJa({
				aopId: "chablis",
				aopNameJa: "シャブリ",
				regionId: "bourgogne",
				countryId: "france",
			}),
		).toBe("シャブリ");
		expect(
			provenanceNameJa({ regionId: "bourgogne", countryId: "france" }),
		).toBe("ブルゴーニュ");
		expect(provenanceNameJa({ countryId: "italy" })).toBe("イタリア");
		expect(provenanceNameJa({})).toBeUndefined();
	});
});
