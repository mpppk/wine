import { describe, expect, it } from "vitest";
import type { WineListCandidate } from "#/lib/ai/wine-list-extraction";
import { bulkRegisterFromScanInput } from "#/lib/import-batch/schema";
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
			regionId: undefined,
			countryId: undefined,
			grapeVarietyIds: ["chardonnay"],
		});
	});

	it("産地は最も細かい1つだけを初期値にする(AOPがあれば地域・国は落とす)", () => {
		const [withAop] = buildImportCards([
			candidate({
				suggestions: { aopId: "chablis", regionId: "bourgogne" },
			}),
		]);
		expect(withAop?.values.aopId).toBe("chablis");
		expect(withAop?.values.regionId).toBeUndefined();

		const [regionOnly] = buildImportCards([
			candidate({
				suggestions: { regionId: "bourgogne", countryId: "france" },
			}),
		]);
		expect(regionOnly?.values.aopId).toBeUndefined();
		expect(regionOnly?.values.regionId).toBe("bourgogne");
		expect(regionOnly?.values.countryId).toBeUndefined();

		const [countryOnly] = buildImportCards([
			candidate({ suggestions: { countryId: "france" } }),
		]);
		expect(countryOnly?.values.countryId).toBe("france");
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

	// 受け取って開いた回(#474 のジョブ化)は手元に File が無く、写真はサーバから
	// 引き継ぐ。そこで申告枚数に「手元の File の枚数」= 0 を渡すと、候補が
	// photoIndexes で写真を指しているぶん検証に落ちて**登録ごと弾かれる**
	// (#482 の本番確認で実際に踏んだ)。申告枚数と photoIndex の整合を固定する。
	it("申告枚数が写真番号を下回る入力はスキーマに弾かれる (#482)", () => {
		const built = buildBulkRegisterInput([card({ localId: "a" })], {
			...meta,
			photoCount: 0,
		});
		expect(built.items[0]?.sighting?.photoIndex).toBe(0);
		expect(bulkRegisterFromScanInput.safeParse(built).success).toBe(false);

		// 引き継ぎ元の枚数を渡せば通る(これが修正後の実際の入力)。
		expect(
			bulkRegisterFromScanInput.safeParse(
				buildBulkRegisterInput([card({ localId: "a" })], {
					...meta,
					photoCount: 1,
				}),
			).success,
		).toBe(true);
	});

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
						regionId: undefined,
						countryId: undefined,
						grapeVarietyIds: ["nebbiolo"],
						note: "",
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

// ---- 銘柄ごとの写真の手当て(#473) ----------------------------------------

describe("写真の手当て", () => {
	const meta = { photoCount: 3 };

	it("その1本だけを写した写真があれば、目撃記録の写真番号にそれを使う", () => {
		// 目撃記録の photoIndex は**銘柄写真の取得元にもなる**(サーバが複製する)ので、
		// 単体の写真があるならそちらを指しておく必要がある。
		const [state] = buildImportCards([
			candidate({ photoIndexes: [0, 2], bottlePhotoIndex: 2 }),
		]);
		if (!state) throw new Error("unreachable");
		const input = buildBulkRegisterInput([state], meta);
		expect(input.items[0]?.sighting?.photoIndex).toBe(2);
		// 手元の写真で足りるので web 画像は送らない
		expect(input.items[0]?.webPhoto).toBeUndefined();
	});

	it("適切な写真が無ければ web 画像のURLと注記を送る", () => {
		const [state] = buildImportCards([
			candidate({
				photoIndexes: [1],
				imageUrl: "https://example.com/barolo.jpg",
				imageNote: "2019年のラベル画像です",
			}),
		]);
		if (!state) throw new Error("unreachable");
		const input = buildBulkRegisterInput([state], meta);
		expect(input.items[0]?.webPhoto).toEqual({
			url: "https://example.com/barolo.jpg",
			note: "2019年のラベル画像です",
		});
		// 一括登録の写真へのフォールバック用に、写真番号は従来どおり載る
		expect(input.items[0]?.sighting?.photoIndex).toBe(1);
		expect(bulkRegisterFromScanInput.safeParse(input).success).toBe(true);
	});

	it("既存エントリへの目撃追加には web 画像を送らない(ユーザの写真を差し替えない)", () => {
		const [state] = buildImportCards([
			candidate({
				imageUrl: "https://example.com/barolo.jpg",
				existing: { id: "e1", name: "Barolo", vintage: 2018, status: "owned" },
			}),
		]);
		if (!state) throw new Error("unreachable");
		const input = buildBulkRegisterInput([state], meta);
		expect(input.items[0]?.existingId).toBe("e1");
		expect(input.items[0]?.webPhoto).toBeUndefined();
	});
});
