import { describe, expect, it } from "vitest";
import { DRUNK_WINE_FIELD_DEFS } from "#/lib/drunk-wine/fields";
import {
	buildCreateInput,
	buildMcpUpdatePatch,
	buildUpdatePatch,
	type DrunkWineFormState,
	fieldsValueFromMcpEntry,
	toFormValues,
} from "./drunk-wine-payload";

// フォームで一通り入力済みの state と、それに対応する既存エントリ
const filled: DrunkWineFormState = {
	name: "Chablis",
	drankOn: "2020-01-02",
	rating: 3,
	vintage: "2018",
	producer: "Dauvissat",
	price: "3000",
	aopId: "chablis",
	grapeVarietyIds: ["chardonnay"],
	memo: "good",
};

const savedEntry = {
	name: "Chablis",
	drankOn: "2020-01-02",
	rating: 3,
	vintage: 2018,
	producer: "Dauvissat",
	price: 3000,
	aopId: "chablis",
	grapeVarietyIds: ["chardonnay"],
	memo: "good",
};

// 何も入力していない新規作成フォームの初期 state
const empty: DrunkWineFormState = {
	name: "",
	drankOn: "",
	rating: null,
	vintage: "",
	producer: "",
	price: "",
	aopId: undefined,
	grapeVarietyIds: [],
	memo: "",
};

const state = (patch: Partial<DrunkWineFormState>): DrunkWineFormState => ({
	...filled,
	...patch,
});

describe("toFormValues", () => {
	it("フィールド定義の snakeKey と過不足なく一致する(UI専用の regionId を含まない)", () => {
		expect(Object.keys(toFormValues(filled)).sort()).toEqual(
			DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey).sort(),
		);
	});

	it("rating の number|null と aopId の undefined を規約側の表現へ正規化する", () => {
		expect(toFormValues(filled).rating).toBe("3");
		expect(toFormValues(state({ rating: null })).rating).toBe("");
		expect(toFormValues(filled).aop_id).toBe("chablis");
		expect(toFormValues(state({ aopId: undefined })).aop_id).toBe("");
	});

	it("入力値をフィールドごとに取り違えていない", () => {
		expect(toFormValues(filled)).toEqual({
			name: "Chablis",
			drank_on: "2020-01-02",
			rating: "3",
			vintage: "2018",
			price: "3000",
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
			memo: "good",
		});
	});
});

describe("buildUpdatePatch", () => {
	it("未変更なら空パッチ(数値・配列・未選択AOPを含む全項目)", () => {
		expect(buildUpdatePatch(savedEntry, filled)).toEqual({});
		expect(
			buildUpdatePatch(
				{ ...savedEntry, aopId: null, rating: null, grapeVarietyIds: [] },
				state({ aopId: undefined, rating: null, grapeVarietyIds: [] }),
			),
		).toEqual({});
	});

	it("id を含めない(呼び出し側が付ける)", () => {
		expect(buildUpdatePatch(savedEntry, state({ memo: "great" }))).toEqual({
			memo: "great",
		});
	});

	it("評価は変更と解除の両方を送る", () => {
		expect(buildUpdatePatch(savedEntry, state({ rating: 5 }))).toEqual({
			rating: 5,
		});
		expect(buildUpdatePatch(savedEntry, state({ rating: null }))).toEqual({
			rating: null,
		});
	});

	it("AOPの紐付け解除は null を送る", () => {
		expect(buildUpdatePatch(savedEntry, state({ aopId: undefined }))).toEqual({
			aopId: null,
		});
	});

	it("ヴィンテージ・価格は空欄でクリア、数値文字列は number になる", () => {
		expect(
			buildUpdatePatch(savedEntry, state({ vintage: "", price: "" })),
		).toEqual({ vintage: null, price: null });
		expect(buildUpdatePatch(savedEntry, state({ vintage: "2019" }))).toEqual({
			vintage: 2019,
		});
	});

	it("メモは空白だけならクリアし、前後空白だけの違いは送らない", () => {
		expect(buildUpdatePatch(savedEntry, state({ memo: "   " }))).toEqual({
			memo: null,
		});
		expect(buildUpdatePatch(savedEntry, state({ memo: " good " }))).toEqual({});
	});

	it("名前は空欄でも送らず、変更はトリムして送る", () => {
		expect(buildUpdatePatch(savedEntry, state({ name: "" }))).toEqual({});
		expect(buildUpdatePatch(savedEntry, state({ name: " Chablis " }))).toEqual(
			{},
		);
		expect(buildUpdatePatch(savedEntry, state({ name: "Meursault" }))).toEqual({
			name: "Meursault",
		});
	});

	it("ぶどう品種は追加を送り、全解除は [] で送る", () => {
		expect(
			buildUpdatePatch(
				savedEntry,
				state({ grapeVarietyIds: ["chardonnay", "aligote"] }),
			),
		).toEqual({ grapeVarietyIds: ["chardonnay", "aligote"] });
		expect(
			buildUpdatePatch(savedEntry, state({ grapeVarietyIds: [] })),
		).toEqual({ grapeVarietyIds: [] });
	});

	it("ぶどう品種の並べ替えだけなら送らない(集合として比較する)", () => {
		expect(
			buildUpdatePatch(
				{ ...savedEntry, grapeVarietyIds: ["chardonnay", "aligote"] },
				state({ grapeVarietyIds: ["aligote", "chardonnay"] }),
			),
		).toEqual({});
	});
});

describe("buildCreateInput", () => {
	it("未入力のフィールドは送らない", () => {
		expect(buildCreateInput({ ...empty, name: "Chablis" })).toEqual({
			name: "Chablis",
		});
	});

	it("入力済みのフィールドを camelCase で送る", () => {
		expect(buildCreateInput(filled)).toEqual({
			name: "Chablis",
			drankOn: "2020-01-02",
			rating: 3,
			vintage: 2018,
			price: 3000,
			producer: "Dauvissat",
			aopId: "chablis",
			grapeVarietyIds: ["chardonnay"],
			memo: "good",
		});
	});

	it("作成入力に null は現れない(空欄はキーごと落ちる)", () => {
		const input = buildCreateInput(
			state({ memo: "", producer: "  ", rating: null, aopId: undefined }),
		);
		expect(Object.values(input)).not.toContain(null);
		expect(input).not.toHaveProperty("memo");
		expect(input).not.toHaveProperty("producer");
		expect(input).not.toHaveProperty("rating");
		expect(input).not.toHaveProperty("aopId");
	});

	it("名前はトリムして必ず送る", () => {
		expect(buildCreateInput(state({ name: " Chablis " })).name).toBe("Chablis");
	});
});

// ---- MCP App(/embed/drunk-wine)側の変換 --------------------------------
// ホストから postMessage で届く snake_case のエントリは外部入力なので、
// 型が違う値でフォームが壊れないことも固定する。

const mcpEntry = {
	id: "e1",
	name: "Chablis",
	drank_on: "2020-01-02",
	rating: 3,
	vintage: 2018,
	producer: "Dauvissat",
	price: 3000,
	aop_id: "chablis",
	region_id: "bourgogne",
	grape_variety_ids: ["chardonnay"],
	memo: "good",
};

describe("fieldsValueFromMcpEntry", () => {
	it("snake_case のエントリをフォームの値へ写す", () => {
		expect(fieldsValueFromMcpEntry(mcpEntry)).toEqual({
			name: "Chablis",
			drankOn: "2020-01-02",
			rating: 3,
			vintage: "2018",
			producer: "Dauvissat",
			price: "3000",
			aopId: "chablis",
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
			memo: "good",
		});
	});

	it("null・欠落・型違いは空の入力に倒す", () => {
		expect(
			fieldsValueFromMcpEntry({
				id: "e1",
				name: null as unknown as string,
				rating: "3" as unknown as number,
				vintage: Number.NaN,
				aop_id: "",
				grape_variety_ids: undefined,
			}),
		).toEqual({
			name: "",
			drankOn: "",
			rating: null,
			vintage: "",
			producer: "",
			price: "",
			aopId: undefined,
			regionId: undefined,
			grapeVarietyIds: [],
			memo: "",
		});
	});
});

describe("buildMcpUpdatePatch", () => {
	it("変更が無ければ空パッチ", () => {
		expect(
			buildMcpUpdatePatch(mcpEntry, fieldsValueFromMcpEntry(mcpEntry)),
		).toEqual({});
	});

	it("変更したフィールドだけを snake_case で返す", () => {
		const value = {
			...fieldsValueFromMcpEntry(mcpEntry),
			name: "Chablis 1er",
			memo: "",
			grapeVarietyIds: [],
		};
		expect(buildMcpUpdatePatch(mcpEntry, value)).toEqual({
			name: "Chablis 1er",
			memo: null,
			grape_variety_ids: [],
		});
	});

	it("regionId は送らない(AOPから導出される)", () => {
		const value = {
			...fieldsValueFromMcpEntry(mcpEntry),
			regionId: "beaujolais",
		};
		expect(buildMcpUpdatePatch(mcpEntry, value)).toEqual({});
	});
});
