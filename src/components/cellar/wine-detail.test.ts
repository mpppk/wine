import { describe, expect, it } from "vitest";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { buildWineDetailRows } from "./wine-detail";

// 閲覧専用画面(/cellar/$entryId)に並ぶ項目の規約:
//  - 値が無い項目は行ごと落とす(状態だけは常に出る)
//  - ID(地域・AOP・ぶどう品種)は静的マスタを引いて日本語名で出す
//  - 未購入(wishlist)では価格を出さない(編集フォームが入力欄を隠す条件と揃える)

const BASE: DrunkWineEntry = {
	id: "e1",
	name: "テストワイン",
	status: "finished",
	lastDrankOn: null,
	tastingCount: 0,
	lastSeenOn: null,
	sightingCount: 0,
	aopId: null,
	aopNameJa: null,
	regionId: null,
	lastRating: null,
	lastMemo: null,
	vintage: null,
	grapeVarietyIds: [],
	producer: null,
	price: null,
	photoUrls: [],
	thumbUrls: [],
	createdAt: 0,
	updatedAt: 0,
};

/** ラベル→値の辞書にして、行の有無と中身を素直に検査できるようにする */
function rowMap(entry: DrunkWineEntry): Map<string, string> {
	return new Map(buildWineDetailRows(entry).map((r) => [r.label, r.value]));
}

describe("buildWineDetailRows", () => {
	it("値が無い項目は行を作らず、状態だけを返す", () => {
		expect(buildWineDetailRows(BASE)).toEqual([
			{ label: "状態", value: "飲み終わった" },
		]);
	});

	it("ヴィンテージ・生産者・価格を表示用に整形する", () => {
		const rows = rowMap({
			...BASE,
			vintage: 2020,
			producer: "ドメーヌ・ルフレーヴ",
			price: 12345,
		});
		expect(rows.get("ヴィンテージ")).toBe("2020年");
		expect(rows.get("生産者")).toBe("ドメーヌ・ルフレーヴ");
		expect(rows.get("価格")).toBe("¥12,345");
	});

	it("未購入(wishlist)では価格を出さない", () => {
		const rows = rowMap({ ...BASE, status: "wishlist", price: 5000 });
		expect(rows.get("状態")).toBe("気になる");
		expect(rows.get("価格")).toBeUndefined();
	});

	it("地域・AOP・ぶどう品種をマスタの日本語名で出す", () => {
		const rows = rowMap({
			...BASE,
			regionId: "bourgogne",
			aopId: "chablis",
			aopNameJa: "シャブリ",
			grapeVarietyIds: ["chardonnay", "pinot-noir"],
		});
		expect(rows.get("地域")).toBe("ブルゴーニュ");
		expect(rows.get("AOP")).toBe("シャブリ");
		expect(rows.get("ぶどう品種")).toBe("シャルドネ、ピノ・ノワール");
	});

	it("aopNameJa が欠けていても aopId から名前を引く", () => {
		const rows = rowMap({ ...BASE, aopId: "chablis", aopNameJa: null });
		expect(rows.get("AOP")).toBe("シャブリ");
	});

	it("マスタに無いぶどう品種IDは落とす", () => {
		const rows = rowMap({
			...BASE,
			grapeVarietyIds: ["chardonnay", "no-such-variety"],
		});
		expect(rows.get("ぶどう品種")).toBe("シャルドネ");
	});
});
