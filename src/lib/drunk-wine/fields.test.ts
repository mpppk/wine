import { describe, expect, it } from "vitest";
import {
	collectDrunkWinePatch,
	collectWineTastingPatch,
	DRUNK_WINE_FIELD_DEFS,
	type DrunkWineFieldDef,
	hasDrunkWinePatch,
	stripDerivedProvenance,
	toCamelPatch,
	toCamelTastingPatch,
	toSnakeEntry,
	WINE_TASTING_FIELDS,
} from "./fields";
import {
	drunkWineFields,
	updateDrunkWineInput,
	updateWineTastingInput,
	wineTastingFields,
} from "./schema";

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

	it("snakeKey 集合が期待の9件と一致する(飲んだ日/評価/メモは飲用記録へ移動済み)", () => {
		const snakeKeys = DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey).sort();
		expect(snakeKeys).toEqual(
			[
				"aop_id",
				"country_id",
				"grape_variety_ids",
				"name",
				"price",
				"producer",
				"region_id",
				"status",
				"vintage",
			].sort(),
		);
	});

	it("name はクリア不可の必須フィールド", () => {
		const name = byCamelKey.get("name");
		expect(name?.clear).toBe("never");
		expect(name?.required).toBe(true);
	});

	it("status は select かつクリア不可(NOT NULL列へ null を送らない)", () => {
		const status = byCamelKey.get("status");
		expect(status?.input).toBe("select");
		expect(status?.clear).toBe("never");
	});

	it("ぶどう品種は [] でクリアする規約", () => {
		expect(byCamelKey.get("grapeVarietyIds")?.clear).toBe("emptyArray");
	});
});

// 更新スキーマは手書きのミラーなので、キー集合とクリア規約を実行時にも突合する
// (コンパイル時のキー欠落検出は schema.ts の Record 代入が担当)。
describe("updateDrunkWineInput と値スキーマの突合", () => {
	it("shape のキーが drunkWineFields ∪ {id} と一致する", () => {
		expect(Object.keys(updateDrunkWineInput.shape).sort()).toEqual(
			[...Object.keys(drunkWineFields), "id"].sort(),
		);
	});

	it("clear:'null' のフィールドだけが null を受理する", () => {
		for (const def of DRUNK_WINE_FIELD_DEFS) {
			const result = updateDrunkWineInput.safeParse({
				id: "e1",
				[def.camelKey]: null,
			});
			expect(
				result.success,
				`${def.camelKey} (clear=${def.clear}) の null 受理`,
			).toBe(def.clear === "null");
		}
	});
});

describe("WINE_TASTING_FIELDS", () => {
	it("camelKey 集合が wineTastingFields のキーと一致する", () => {
		expect(WINE_TASTING_FIELDS.map((d) => d.camelKey).sort()).toEqual(
			Object.keys(wineTastingFields).sort(),
		);
	});

	it("updateWineTastingInput の全フィールドが null を受理する(列のクリア)", () => {
		for (const def of WINE_TASTING_FIELDS) {
			expect(
				updateWineTastingInput.safeParse({ id: "t1", [def.camelKey]: null })
					.success,
			).toBe(true);
		}
	});
});

describe("collectDrunkWinePatch", () => {
	it("未変更なら空パッチ", () => {
		const entry = {
			name: "Chablis",
			status: "finished",
			vintage: 2018,
			price: 3000,
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
		};
		const values = {
			name: "Chablis",
			status: "finished",
			vintage: "2018",
			price: "3000",
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
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
		expect(collectDrunkWinePatch({}, { price: "4" })).toEqual({ price: 4 });
		expect(collectDrunkWinePatch({ price: 5 }, { price: "" })).toEqual({
			price: null,
		});
	});

	it("name は空欄にしても送らない(クリア不可)が、変更は送る", () => {
		expect(collectDrunkWinePatch({ name: "A" }, { name: "" })).toEqual({});
		expect(collectDrunkWinePatch({ name: "A" }, { name: "B" })).toEqual({
			name: "B",
		});
	});

	it("status は変更時だけ送り、null は決して送らない", () => {
		expect(
			collectDrunkWinePatch({ status: "finished" }, { status: "owned" }),
		).toEqual({ status: "owned" });
		expect(
			collectDrunkWinePatch({ status: "owned" }, { status: "owned" }),
		).toEqual({});
		// 空文字(select が値を持たない異常系)でもクリアを送らない
		expect(collectDrunkWinePatch({ status: "owned" }, { status: "" })).toEqual(
			{},
		);
	});

	it("非表示のフィールドの値を保持していれば差分に載らない(wishlist の価格)", () => {
		// 価格入力は wishlist で描画しないが state は残す。空文字にすると
		// price: null のクリアが飛んで既存値が失われる。
		expect(
			collectDrunkWinePatch(
				{ status: "owned", price: 3000 },
				{ status: "wishlist", price: "3000" },
			),
		).toEqual({ status: "wishlist" });
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

	it("テキストの変更を送る", () => {
		expect(
			collectDrunkWinePatch({ aop_id: "chablis" }, { aop_id: "morgon" }),
		).toEqual({ aop_id: "morgon" });
	});
});

describe("collectWineTastingPatch", () => {
	it("未変更なら空パッチ", () => {
		expect(
			collectWineTastingPatch(
				{ drank_on: "2020-01-02", rating: 4, memo: "good" },
				{ drank_on: "2020-01-02", rating: "4", memo: "good" },
			),
		).toEqual({});
	});

	it("空欄は null でクリアする(記録の行は消さない)", () => {
		expect(
			collectWineTastingPatch(
				{ drank_on: "2020-01-02", rating: 4, memo: "good" },
				{ drank_on: "", rating: "", memo: "" },
			),
		).toEqual({ drank_on: null, rating: null, memo: null });
	});

	it("評価は Number() でパースする", () => {
		expect(collectWineTastingPatch({}, { rating: "5" })).toEqual({ rating: 5 });
	});

	it("日付の変更を送る", () => {
		expect(
			collectWineTastingPatch(
				{ drank_on: "2020-01-01" },
				{ drank_on: "2020-02-02" },
			),
		).toEqual({ drank_on: "2020-02-02" });
	});
});

describe("toSnakeEntry", () => {
	// サービス層の DrunkWineEntry 相当(フィールド定義に無いキーを含む)
	const entry = {
		id: "e1",
		name: "Chablis",
		status: "finished",
		lastDrankOn: "2020-01-02",
		tastingCount: 1,
		drankOn: "2020-01-02",
		aopId: "chablis",
		aopNameJa: "シャブリ",
		regionId: "bourgogne",
		rating: 4,
		memo: "good",
		vintage: 2018,
		grapeVarietyIds: ["chardonnay"],
		producer: "Dauvissat",
		price: 3000,
		photoUrls: ["/api/images/x"],
		createdAt: 1,
		updatedAt: 2,
	};

	it("フィールド定義のキーちょうどに射影する(定義外のキーは落ちる)", () => {
		const snake = toSnakeEntry(entry);
		expect(Object.keys(snake).sort()).toEqual(
			DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey).sort(),
		);
		expect(snake).toEqual({
			name: "Chablis",
			status: "finished",
			vintage: 2018,
			price: 3000,
			producer: "Dauvissat",
			aop_id: "chablis",
			// entry の regionId は導出値(AOPの地域)、countryId は定義に写した undefined
			region_id: "bourgogne",
			country_id: undefined,
			grape_variety_ids: ["chardonnay"],
		});
	});

	it("DBのnullとフォームの空欄は差分にならない", () => {
		const cleared = {
			name: "Chablis",
			status: "finished",
			aopId: null,
			vintage: null,
			grapeVarietyIds: [],
			producer: null,
			price: null,
		};
		const values = {
			name: "Chablis",
			status: "finished",
			vintage: "",
			price: "",
			producer: "",
			aop_id: "",
			grape_variety_ids: [],
		};
		expect(collectDrunkWinePatch(toSnakeEntry(cleared), values)).toEqual({});
	});
});

describe("stripDerivedProvenance", () => {
	it("aop_id があれば導出値の region_id / country_id を落とす", () => {
		expect(
			stripDerivedProvenance({
				aop_id: "chablis",
				region_id: "bourgogne",
				country_id: "france",
			}),
		).toEqual({
			aop_id: "chablis",
			region_id: undefined,
			country_id: undefined,
		});
	});

	it("region_id だけなら country_id(導出)を落とす", () => {
		expect(
			stripDerivedProvenance({
				aop_id: null,
				region_id: "bourgogne",
				country_id: "france",
			}),
		).toEqual({ aop_id: null, region_id: "bourgogne", country_id: undefined });
	});

	it("国のみ・未紐付けはそのまま", () => {
		expect(
			stripDerivedProvenance({ aop_id: null, country_id: "france" }),
		).toEqual({ aop_id: null, country_id: "france" });
		expect(stripDerivedProvenance({ name: "x" })).toEqual({ name: "x" });
	});
});

describe("toCamelPatch", () => {
	it("snakeKey を camelKey に読み替える", () => {
		expect(
			toCamelPatch({ aop_id: "morgon", grape_variety_ids: ["gamay"] }),
		).toEqual({ aopId: "morgon", grapeVarietyIds: ["gamay"] });
	});

	it("空パッチは空のまま", () => {
		expect(toCamelPatch({})).toEqual({});
	});

	it("null(クリア)は落とさず、undefined(未指定)は落とす", () => {
		expect(toCamelPatch({ aop_id: null, producer: undefined })).toEqual({
			aopId: null,
		});
	});

	it("全フィールドを渡すと値スキーマのキー集合と一致する", () => {
		const full = Object.fromEntries(
			DRUNK_WINE_FIELD_DEFS.map((d) => [d.snakeKey, "x"]),
		);
		expect(Object.keys(toCamelPatch(full)).sort()).toEqual(
			Object.keys(drunkWineFields).sort(),
		);
	});
});

describe("toCamelTastingPatch", () => {
	it("snakeKey を camelKey に読み替え、undefined は落とす", () => {
		expect(
			toCamelTastingPatch({ drank_on: "2020-01-02", rating: undefined }),
		).toEqual({ drankOn: "2020-01-02" });
	});

	it("null(クリア)は残す", () => {
		expect(toCamelTastingPatch({ memo: null })).toEqual({ memo: null });
	});
});

describe("hasDrunkWinePatch", () => {
	it("変更が無ければ false", () => {
		expect(hasDrunkWinePatch({})).toBe(false);
		expect(hasDrunkWinePatch({ producer: undefined })).toBe(false);
	});

	it("クリア(null)は変更として扱う", () => {
		expect(hasDrunkWinePatch({ producer: null })).toBe(true);
	});

	it("値の変更は変更として扱う", () => {
		expect(hasDrunkWinePatch({ price: 5 })).toBe(true);
	});
});
