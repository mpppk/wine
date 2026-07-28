import { describe, expect, it } from "vitest";
import { DRUNK_WINE_FIELD_DEFS } from "#/lib/drunk-wine/fields";
import {
	buildCreateInput,
	buildMcpTastingArgs,
	buildMcpUpdatePatch,
	buildTastingInput,
	buildUpdatePatch,
	type DrunkWineFieldsValue,
	type DrunkWineFormState,
	EMPTY_TASTING_DRAFT,
	fieldsValueFromMcpEntry,
	hasUnsavedDrunkWineChanges,
	tastingDraftFromMcpEntry,
	toFormValues,
	type WineTastingDraft,
} from "./drunk-wine-payload";

// フォームで一通り入力済みの state と、それに対応する既存エントリ
const filled: DrunkWineFormState = {
	name: "Chablis",
	status: "finished",
	vintage: "2018",
	producer: "Dauvissat",
	price: "3000",
	aopId: "chablis",
	grapeVarietyIds: ["chardonnay"],
};

const savedEntry = {
	name: "Chablis",
	status: "finished",
	vintage: 2018,
	producer: "Dauvissat",
	price: 3000,
	aopId: "chablis",
	grapeVarietyIds: ["chardonnay"],
};

// 何も入力していない新規作成フォームの初期 state
const empty: DrunkWineFormState = {
	name: "",
	status: "finished",
	vintage: "",
	producer: "",
	price: "",
	aopId: undefined,
	grapeVarietyIds: [],
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

	it("aopId の undefined を規約側の表現へ正規化する", () => {
		expect(toFormValues(filled).aop_id).toBe("chablis");
		expect(toFormValues(state({ aopId: undefined })).aop_id).toBe("");
	});

	it("入力値をフィールドごとに取り違えていない", () => {
		expect(toFormValues(filled)).toEqual({
			name: "Chablis",
			status: "finished",
			vintage: "2018",
			price: "3000",
			producer: "Dauvissat",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
		});
	});
});

describe("buildUpdatePatch", () => {
	it("未変更なら空パッチ(数値・配列・未選択AOPを含む全項目)", () => {
		expect(buildUpdatePatch(savedEntry, filled)).toEqual({});
		expect(
			buildUpdatePatch(
				{ ...savedEntry, aopId: null, grapeVarietyIds: [] },
				state({ aopId: undefined, grapeVarietyIds: [] }),
			),
		).toEqual({});
	});

	it("id を含めない(呼び出し側が付ける)", () => {
		expect(
			buildUpdatePatch(savedEntry, state({ producer: "Raveneau" })),
		).toEqual({ producer: "Raveneau" });
	});

	it("所有状態の変更を送る", () => {
		expect(buildUpdatePatch(savedEntry, state({ status: "owned" }))).toEqual({
			status: "owned",
		});
	});

	it("wishlist へ変えても価格の state を保持していればクリアしない", () => {
		// 価格入力は wishlist で描画しないが、state を残すことで既存値が消えない
		expect(buildUpdatePatch(savedEntry, state({ status: "wishlist" }))).toEqual(
			{
				status: "wishlist",
			},
		);
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

	it("生産者は空白だけならクリアし、前後空白だけの違いは送らない", () => {
		expect(buildUpdatePatch(savedEntry, state({ producer: "   " }))).toEqual({
			producer: null,
		});
		expect(
			buildUpdatePatch(savedEntry, state({ producer: " Dauvissat " })),
		).toEqual({});
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
	it("未入力のフィールドは送らない(status は必ず送る)", () => {
		expect(buildCreateInput({ ...empty, name: "Chablis" })).toEqual({
			name: "Chablis",
			status: "finished",
		});
	});

	it("入力済みのフィールドを camelCase で送る", () => {
		expect(buildCreateInput(filled)).toEqual({
			name: "Chablis",
			status: "finished",
			vintage: 2018,
			price: 3000,
			producer: "Dauvissat",
			aopId: "chablis",
			grapeVarietyIds: ["chardonnay"],
		});
	});

	it("飲用記録を渡すと tasting としてネストする", () => {
		const input = buildCreateInput(filled, {
			drankOn: "2020-01-02",
			rating: 4,
		});
		expect(input.tasting).toEqual({ drankOn: "2020-01-02", rating: 4 });
	});

	it("作成入力に null は現れない(空欄はキーごと落ちる)", () => {
		const input = buildCreateInput(
			state({ producer: "  ", aopId: undefined, price: "" }),
		);
		expect(Object.values(input)).not.toContain(null);
		expect(input).not.toHaveProperty("producer");
		expect(input).not.toHaveProperty("aopId");
		expect(input).not.toHaveProperty("price");
	});

	it("名前はトリムして必ず送る", () => {
		expect(buildCreateInput(state({ name: " Chablis " })).name).toBe("Chablis");
	});
});

describe("buildTastingInput", () => {
	it("全項目が空なら undefined(記録を作らない)", () => {
		expect(
			buildTastingInput({ drankOn: "", rating: null, memo: "  " }),
		).toBeUndefined();
	});

	it("1つでも入力があれば作成入力を返す", () => {
		expect(buildTastingInput({ drankOn: "", rating: 4, memo: "" })).toEqual({
			drankOn: undefined,
			rating: 4,
			memo: undefined,
		});
	});

	it("メモはトリムする", () => {
		expect(
			buildTastingInput({ drankOn: "", rating: null, memo: " good " })?.memo,
		).toBe("good");
	});
});

// ---- MCP App(/embed/drunk-wine)側の変換 --------------------------------
// ホストから postMessage で届く snake_case のエントリは外部入力なので、
// 型が違う値でフォームが壊れないことも固定する。

const mcpEntry = {
	id: "e1",
	name: "Chablis",
	status: "finished",
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
			status: "finished",
			vintage: "2018",
			producer: "Dauvissat",
			price: "3000",
			aopId: "chablis",
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
		});
	});

	it("null・欠落・型違いは空の入力に倒す", () => {
		expect(
			fieldsValueFromMcpEntry({
				id: "e1",
				name: null as unknown as string,
				status: "unknown-status",
				vintage: Number.NaN,
				aop_id: "",
				grape_variety_ids: undefined,
			}),
		).toEqual({
			name: "",
			// 未知の status は既定へ倒す(1フィールドの不正で全体を壊さない)
			status: "finished",
			vintage: "",
			producer: "",
			price: "",
			aopId: undefined,
			regionId: undefined,
			grapeVarietyIds: [],
		});
	});
});

describe("tastingDraftFromMcpEntry", () => {
	it("最新1件の射影をフォームの値へ写す", () => {
		expect(tastingDraftFromMcpEntry(mcpEntry)).toEqual({
			drankOn: "2020-01-02",
			rating: 3,
			memo: "good",
		});
	});

	it("欠落・型違いは空に倒す", () => {
		expect(
			tastingDraftFromMcpEntry({
				id: "e1",
				rating: "3" as unknown as number,
			}),
		).toEqual({ drankOn: "", rating: null, memo: "" });
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
			producer: "",
			grapeVarietyIds: [],
		};
		expect(buildMcpUpdatePatch(mcpEntry, value)).toEqual({
			name: "Chablis 1er",
			producer: null,
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

	it("ホストが status を落としても、未編集なら status を送らない", () => {
		// 素の entry を基準にすると status:"finished" を送ってしまい、
		// 手元にあるワインが黙って飲み終わり扱いになる
		const { status: _omitted, ...withoutStatus } = mcpEntry;
		expect(
			buildMcpUpdatePatch(
				withoutStatus,
				fieldsValueFromMcpEntry(withoutStatus),
			),
		).toEqual({});
	});

	it("status を落としたエントリでも、ユーザが変えた分は送る", () => {
		const { status: _omitted, ...withoutStatus } = mcpEntry;
		const value = {
			...fieldsValueFromMcpEntry(withoutStatus),
			status: "owned" as const,
		};
		expect(buildMcpUpdatePatch(withoutStatus, value)).toEqual({
			status: "owned",
		});
	});
});

describe("buildMcpTastingArgs", () => {
	const draft = tastingDraftFromMcpEntry(mcpEntry);

	it("変更が無ければ空", () => {
		expect(buildMcpTastingArgs(mcpEntry, draft)).toEqual({});
	});

	it("変更した項目だけをレガシー引数名(snake_case)で返す", () => {
		expect(
			buildMcpTastingArgs(mcpEntry, {
				...draft,
				rating: 5,
			} as WineTastingDraft),
		).toEqual({ rating: 5 });
	});

	it("空欄は null(その列のクリア)として送る", () => {
		expect(buildMcpTastingArgs(mcpEntry, { ...draft, memo: "" })).toEqual({
			memo: null,
		});
	});
});

// 離脱ガードの判定(#238)。ここが緩むと「変更したのに警告が出ない」= 入力が消える。
// AIクレジットを消費した自動入力も同じ state に載るので、検出漏れは実損になる。
describe("hasUnsavedDrunkWineChanges", () => {
	const initial = { ...empty, regionId: undefined } as DrunkWineFieldsValue;
	const base = {
		initial,
		values: initial,
		tasting: EMPTY_TASTING_DRAFT,
		initialPhotoKeys: [] as string[],
		photoKeys: [] as (string | null)[],
	};

	it("何も触っていない新規フォームは未保存扱いにしない", () => {
		expect(hasUnsavedDrunkWineChanges(base)).toBe(false);
	});

	it("入力すると未保存になる", () => {
		expect(
			hasUnsavedDrunkWineChanges({
				...base,
				values: { ...initial, name: "Chablis" },
			}),
		).toBe(true);
	});

	it("エチケット解析で埋まる項目(生産者・ヴィンテージ・AOP・品種)も検出する", () => {
		// 自動入力はAIクレジットを消費するので、ここを取りこぼすと実損になる
		for (const patch of [
			{ producer: "Dauvissat" },
			{ vintage: "2018" },
			{ aopId: "chablis" },
			{ grapeVarietyIds: ["chardonnay"] },
		]) {
			expect(
				hasUnsavedDrunkWineChanges({
					...base,
					values: { ...initial, ...patch },
				}),
			).toBe(true);
		}
	});

	it("前後空白だけの違いと品種の並び順は未保存扱いにしない", () => {
		const saved = {
			...initial,
			name: "Chablis",
			grapeVarietyIds: ["chardonnay", "aligote"],
		} as DrunkWineFieldsValue;
		expect(
			hasUnsavedDrunkWineChanges({
				...base,
				initial: saved,
				values: {
					...saved,
					name: "  Chablis  ",
					grapeVarietyIds: ["aligote", "chardonnay"],
				},
			}),
		).toBe(false);
	});

	it("編集時は保存済みの値との差分で判定する", () => {
		const saved = { ...initial, name: "Chablis" } as DrunkWineFieldsValue;
		expect(
			hasUnsavedDrunkWineChanges({ ...base, initial: saved, values: saved }),
		).toBe(false);
		expect(
			hasUnsavedDrunkWineChanges({
				...base,
				initial: saved,
				values: { ...saved, price: "3000" },
			}),
		).toBe(true);
	});

	it("飲用記録の下書き(飲んだ日・評価・メモ)も未保存として扱う", () => {
		for (const tasting of [
			{ ...EMPTY_TASTING_DRAFT, drankOn: "2026-07-28" },
			{ ...EMPTY_TASTING_DRAFT, rating: 4 },
			{ ...EMPTY_TASTING_DRAFT, memo: "good" },
		]) {
			expect(hasUnsavedDrunkWineChanges({ ...base, tasting })).toBe(true);
		}
	});

	it("写真の追加・削除・並べ替えを未保存として扱う", () => {
		const saved = {
			...base,
			initialPhotoKeys: ["wines/u/a.jpg", "wines/u/b.jpg"],
		};
		// 変更なし
		expect(
			hasUnsavedDrunkWineChanges({
				...saved,
				photoKeys: ["wines/u/a.jpg", "wines/u/b.jpg"],
			}),
		).toBe(false);
		// 追加(未保存の新規写真は null)
		expect(
			hasUnsavedDrunkWineChanges({
				...saved,
				photoKeys: ["wines/u/a.jpg", "wines/u/b.jpg", null],
			}),
		).toBe(true);
		// 削除
		expect(
			hasUnsavedDrunkWineChanges({ ...saved, photoKeys: ["wines/u/a.jpg"] }),
		).toBe(true);
		// 並べ替え(先頭=代表写真が変わる)
		expect(
			hasUnsavedDrunkWineChanges({
				...saved,
				photoKeys: ["wines/u/b.jpg", "wines/u/a.jpg"],
			}),
		).toBe(true);
	});
});
