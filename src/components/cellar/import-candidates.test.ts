import { describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import {
	buildBulkRegisterInput,
	buildImportCards,
	detachExisting,
	type ImportCardState,
	summarizeImportCards,
	validateImportCards,
} from "./import-candidates";

function candidate(
	partial: Partial<WineListCandidate> = {},
): WineListCandidate {
	return {
		suggestions: { name: "Chablis" },
		photoIndexes: [0],
		...partial,
	};
}

/** カードを1件作って、テストごとに必要なところだけ差し替える。 */
function card(partial: Partial<ImportCardState> = {}): ImportCardState {
	const [base] = buildImportCards([candidate()]);
	if (!base) throw new Error("unreachable");
	return { ...base, ...partial };
}

describe("buildImportCards", () => {
	it("解析結果をカードの初期状態にする(既定は登録ON・見かけた)", () => {
		const [state] = buildImportCards([
			candidate({
				suggestions: {
					name: "Chablis Les Clos",
					producer: "Vincent Dauvissat",
					vintage: 2020,
					aopId: "chablis-grand-cru",
					regionId: "bourgogne",
					grapeVarietyIds: ["chardonnay"],
				},
				price: 24000,
				photoIndexes: [0, 1],
			}),
		]);
		expect(state).toMatchObject({
			selected: true,
			drunk: false,
			sightingPrice: "24000",
			photoIndexes: [0, 1],
		});
		expect(state?.values).toMatchObject({
			name: "Chablis Les Clos",
			producer: "Vincent Dauvissat",
			vintage: "2020",
			status: "spotted",
			aopId: "chablis-grand-cru",
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
		});
	});

	it("リスト記載の価格は銘柄ではなく目撃記録側に入れる(店ごとに違うため)", () => {
		const [state] = buildImportCards([candidate({ price: 9800 })]);
		expect(state?.sightingPrice).toBe("9800");
		expect(state?.values.price).toBe("");
	});

	it("カードごとに異なる localId を振る(入力欄の id 衝突を防ぐ)", () => {
		const cards = buildImportCards([candidate(), candidate(), candidate()]);
		expect(new Set(cards.map((c) => c.localId)).size).toBe(3);
	});
});

describe("detachExisting", () => {
	it("既存一致を外す(編集したら新規作成に切り替わる)", () => {
		const withExisting = card({
			existing: {
				id: "e1",
				name: "Chablis",
				vintage: 2020,
				status: "finished",
			},
		});
		expect(detachExisting(withExisting).existing).toBeUndefined();
	});

	it("既存一致が無ければ同じ参照を返す(不要な再レンダリングを作らない)", () => {
		const plain = card();
		expect(detachExisting(plain)).toBe(plain);
	});
});

describe("summarizeImportCards / validateImportCards", () => {
	it("チェックの入ったカードだけを数える", () => {
		const summary = summarizeImportCards([
			card({ localId: "a" }),
			card({ localId: "b", selected: false }),
			card({
				localId: "c",
				existing: { id: "e1", name: "既存", vintage: null, status: "owned" },
			}),
			card({ localId: "d", drunk: true }),
		]);
		expect(summary).toEqual({ selected: 3, create: 2, attach: 1, drunk: 1 });
	});

	it("1件も選ばれていなければ送信できない", () => {
		expect(validateImportCards([card({ selected: false })])).toContain(
			"1つ以上",
		);
	});

	it("名前が空の新規カードが選ばれていれば送信できない", () => {
		const nameless = card({ values: { ...card().values, name: "  " } });
		expect(validateImportCards([nameless])).toContain("名前");
	});

	it("名前が空でも既存一致なら送信できる(銘柄を作らないため)", () => {
		const attach = card({
			values: { ...card().values, name: "" },
			existing: { id: "e1", name: "既存", vintage: null, status: "spotted" },
		});
		expect(validateImportCards([attach])).toBeNull();
	});
});

describe("buildBulkRegisterInput", () => {
	const meta = { photoCount: 2, seenOn: "2026-08-01" };

	it("チェックの外れたカードは送らない", () => {
		const input = buildBulkRegisterInput(
			[card({ localId: "a" }), card({ localId: "b", selected: false })],
			meta,
		);
		expect(input.items).toHaveLength(1);
	});

	it("新規カードは銘柄と目撃記録を送る(銘柄の入力規約は buildCreateInput と共有)", () => {
		const input = buildBulkRegisterInput(
			[
				card({
					values: {
						name: "Barolo Brunate",
						status: "spotted",
						vintage: "2018",
						producer: "Giuseppe Rinaldi",
						price: "",
						aopId: "barolo",
						regionId: "piemonte",
						grapeVarietyIds: ["nebbiolo"],
					},
					sightingPrice: "28000",
					photoIndexes: [1],
				}),
			],
			meta,
		);
		expect(input.items[0]).toEqual({
			wine: {
				name: "Barolo Brunate",
				status: "spotted",
				vintage: 2018,
				producer: "Giuseppe Rinaldi",
				aopId: "barolo",
				grapeVarietyIds: ["nebbiolo"],
			},
			sighting: { photoIndex: 1, price: 28000 },
		});
	});

	it("既存一致のカードは銘柄を作らず existingId で送る", () => {
		const input = buildBulkRegisterInput(
			[
				card({
					existing: {
						id: "entry-1",
						name: "Chablis",
						vintage: 2020,
						status: "finished",
					},
				}),
			],
			meta,
		);
		expect(input.items[0]).toMatchObject({ existingId: "entry-1" });
		expect(input.items[0]).not.toHaveProperty("wine");
	});

	it("写真番号は先頭の1枚だけを目撃記録に持たせる(1回の目撃を写真数で水増ししない)", () => {
		const input = buildBulkRegisterInput(
			[card({ photoIndexes: [0, 1] })],
			meta,
		);
		expect(input.items[0]?.sighting?.photoIndex).toBe(0);
	});

	it("「飲んだ」トグルON なら中身が空でも飲用記録を作る", () => {
		const input = buildBulkRegisterInput([card({ drunk: true })], meta);
		expect(input.items[0]?.tasting).toEqual({});
	});

	it("「飲んだ」トグルOFF なら飲用記録は送らない", () => {
		const input = buildBulkRegisterInput(
			[
				card({
					drunk: false,
					tasting: { drankOn: "2026-07-01", rating: 4, memo: "" },
				}),
			],
			meta,
		);
		expect(input.items[0]?.tasting).toBeUndefined();
	});

	it("場所は既存の選択と新規作成を排他で送る", () => {
		expect(
			buildBulkRegisterInput([card()], { ...meta, placeId: "p1" }),
		).toMatchObject({ placeId: "p1" });
		expect(
			buildBulkRegisterInput([card()], { ...meta, newPlaceName: " ビストロ " }),
		).toMatchObject({ newPlace: { name: "ビストロ" } });
		// 空白だけの名前は新規作成として送らない(サーバの min(1) で弾かれる前に落とす)
		expect(
			buildBulkRegisterInput([card()], { ...meta, newPlaceName: "   " }),
		).not.toHaveProperty("newPlace");
	});
});
