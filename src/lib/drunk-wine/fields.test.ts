import { describe, expect, it } from "vitest";
import {
	collectDrunkWinePatch,
	DRUNK_WINE_FIELD_DEFS,
	type DrunkWineFieldDef,
} from "./fields";
import { drunkWineFields, RATING_MAX, RATING_MIN } from "./schema";

const byCamelKey = new Map(
	(DRUNK_WINE_FIELD_DEFS as readonly DrunkWineFieldDef[]).map((d) => [
		d.camelKey,
		d,
	]),
);

describe("DRUNK_WINE_FIELD_DEFS", () => {
	it("camelKey 集合が値スキーマ drunkWineFields のキーと過不足なく一致する", () => {
		const camelKeys = DRUNK_WINE_FIELD_DEFS.map((d) => d.camelKey).sort();
		const schemaKeys = Object.keys(drunkWineFields).sort();
		expect(camelKeys).toEqual(schemaKeys);
	});

	it("snakeKey 集合が期待の9件と一致する", () => {
		const snakeKeys = DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey).sort();
		expect(snakeKeys).toEqual(
			[
				"aop_id",
				"drank_on",
				"grape_variety_ids",
				"memo",
				"name",
				"price",
				"producer",
				"rating",
				"vintage",
			].sort(),
		);
	});

	it("name はクリア不可の必須フィールド", () => {
		const name = byCamelKey.get("name");
		expect(name?.clear).toBe("never");
		expect(name?.required).toBe(true);
	});

	it("ぶどう品種は [] でクリアする規約", () => {
		expect(byCamelKey.get("grapeVarietyIds")?.clear).toBe("emptyArray");
	});

	it("評価の下限・上限が値スキーマの定数と揃っている", () => {
		const rating = byCamelKey.get("rating");
		expect(rating?.input).toBe("rating");
		expect(rating?.min).toBe(RATING_MIN);
		expect(rating?.max).toBe(RATING_MAX);
	});
});

describe("collectDrunkWinePatch", () => {
	it("未変更なら空パッチ", () => {
		const entry = {
			name: "Chablis",
			drank_on: "2020-01-02",
			rating: 4,
			vintage: 2018,
			price: 3000,
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
			memo: "good",
		};
		const values = {
			name: "Chablis",
			drank_on: "2020-01-02",
			rating: "4",
			vintage: "2018",
			price: "3000",
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
			memo: "good",
		};
		expect(collectDrunkWinePatch(entry, values)).toEqual({});
	});

	it("空欄はnullでクリアする(producer)", () => {
		expect(collectDrunkWinePatch({ producer: "X" }, { producer: "" })).toEqual({
			producer: null,
		});
	});

	it("前後空白はトリムして比較する", () => {
		expect(
			collectDrunkWinePatch({ producer: "X" }, { producer: "  X  " }),
		).toEqual({});
	});

	it("数値フィールドは Number() でパースし、空欄はnull", () => {
		expect(collectDrunkWinePatch({}, { rating: "4" })).toEqual({ rating: 4 });
		expect(collectDrunkWinePatch({ rating: 5 }, { rating: "" })).toEqual({
			rating: null,
		});
	});

	it("name は空欄にしても送らない(クリア不可)が、変更は送る", () => {
		expect(collectDrunkWinePatch({ name: "A" }, { name: "" })).toEqual({});
		expect(collectDrunkWinePatch({ name: "A" }, { name: "B" })).toEqual({
			name: "B",
		});
	});

	it("ぶどう品種は全解除で [] を送る", () => {
		expect(
			collectDrunkWinePatch(
				{ grape_variety_ids: ["gamay"] },
				{ grape_variety_ids: [] },
			),
		).toEqual({ grape_variety_ids: [] });
	});

	it("ぶどう品種の比較は順序非依存", () => {
		expect(
			collectDrunkWinePatch(
				{ grape_variety_ids: ["a", "b"] },
				{ grape_variety_ids: ["b", "a"] },
			),
		).toEqual({});
	});

	it("日付・テキストの変更を送る", () => {
		expect(
			collectDrunkWinePatch(
				{ drank_on: "2020-01-01" },
				{ drank_on: "2020-02-02" },
			),
		).toEqual({ drank_on: "2020-02-02" });
	});
});
