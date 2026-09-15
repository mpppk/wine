import { describe, expect, it } from "vitest";
import type { WineEncounterEntry } from "#/lib/services/drunk-wine-service";
import {
	buildAddEncounterInput,
	buildCreateEntryEncounterInput,
	buildUpdateEncounterInput,
	draftFromEncounter,
	draftFromLabelJobEncounter,
	NEW_PLACE_VALUE,
	type WineEncounterDraft,
} from "./encounter-payload";

function encounter(
	partial: Partial<WineEncounterEntry> = {},
): WineEncounterEntry {
	return {
		id: "e1",
		drank: false,
		occurredOn: null,
		rating: null,
		price: null,
		memo: null,
		placeId: null,
		placeName: null,
		batchId: null,
		photoIndex: null,
		photoUrl: null,
		photoUrls: [],
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

function draft(partial: Partial<WineEncounterDraft> = {}): WineEncounterDraft {
	return {
		drank: false,
		occurredOn: "",
		placeId: "",
		newPlaceName: "",
		rating: null,
		price: "",
		memo: "",
		...partial,
	};
}

describe("draftFromEncounter", () => {
	it("null をフォームの空欄に写す", () => {
		expect(draftFromEncounter(encounter())).toEqual(draft());
	});

	it("保存済みの値をフォームに戻す(価格は文字列)", () => {
		expect(
			draftFromEncounter(
				encounter({
					drank: true,
					occurredOn: "2026-08-01",
					placeId: "p1",
					rating: 4,
					price: 12000,
					memo: "旨い",
				}),
			),
		).toEqual(
			draft({
				drank: true,
				occurredOn: "2026-08-01",
				placeId: "p1",
				rating: 4,
				price: "12000",
				memo: "旨い",
			}),
		);
	});
});

// 解析を投げて離脱した回の復元。ジョブに残した内容をフォーム値へ戻す。
describe("draftFromLabelJobEncounter", () => {
	it("既存の場所と撮影日を戻す", () => {
		expect(
			draftFromLabelJobEncounter({ placeId: "p1", seenOn: "2026-08-09" }),
		).toEqual(draft({ placeId: "p1", occurredOn: "2026-08-09" }));
	});

	it("新しい場所は「新しい場所を追加…」の選択状態で戻す(place はまだ無い)", () => {
		expect(draftFromLabelJobEncounter({ newPlaceName: "ビストロ" })).toEqual(
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: "ビストロ" }),
		);
	});

	it("撮影日だけの回も戻せる", () => {
		expect(draftFromLabelJobEncounter({ seenOn: "2026-08-09" })).toEqual(
			draft({ occurredOn: "2026-08-09" }),
		);
	});

	// 復元 → 送信で往復しても同じ内容になること(ここがズレると、受け取った回だけ
	// 場所が落ちる・二重に場所が増える、が静かに起きる)
	it("復元した下書きは、そのまま作成入力へ戻せる", () => {
		expect(
			buildCreateEntryEncounterInput(
				draftFromLabelJobEncounter({
					newPlaceName: "ビストロ",
					seenOn: "2026-08-09",
				}),
			),
		).toEqual({
			drank: false,
			newPlace: { name: "ビストロ" },
			occurredOn: "2026-08-09",
		});
	});
});

// 銘柄の新規作成に添える体験記録。写真から登録した回の「場所・撮影日」が
// ここを通ってサーバへ渡る。
describe("buildCreateEntryEncounterInput", () => {
	it("全欄が空でトグルOFFなら記録を作らない(undefined)", () => {
		expect(buildCreateEntryEncounterInput(draft())).toBeUndefined();
	});

	it("トグルONなら全項目が空でも記録を作る(飲んだ事実は残す)", () => {
		expect(buildCreateEntryEncounterInput(draft({ drank: true }))).toEqual({
			drank: true,
		});
	});

	it("既存の場所と日付を送る", () => {
		expect(
			buildCreateEntryEncounterInput(
				draft({ placeId: "p1", occurredOn: "2026-08-09" }),
			),
		).toEqual({ drank: false, placeId: "p1", occurredOn: "2026-08-09" });
	});

	it("飲んだ回は評価も送る", () => {
		expect(
			buildCreateEntryEncounterInput(
				draft({ drank: true, occurredOn: "2026-08-09", rating: 4 }),
			),
		).toEqual({ drank: true, occurredOn: "2026-08-09", rating: 4 });
	});

	it("飲んでいない回の評価は送らない(トグルOFFでは入力できないが念のため)", () => {
		const input = buildCreateEntryEncounterInput(
			draft({ occurredOn: "2026-08-09", rating: 4 }),
		);
		expect(input).not.toHaveProperty("rating");
	});

	it("新規の場所は newPlace として送る(placeId は送らない)", () => {
		const input = buildCreateEntryEncounterInput(
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: " ビストロ " }),
		);
		expect(input).toEqual({ drank: false, newPlace: { name: "ビストロ" } });
		expect(input).not.toHaveProperty("placeId");
	});

	it("新規の場所を選んで名前が空なら、場所なしの記録にする", () => {
		expect(
			buildCreateEntryEncounterInput(
				draft({ placeId: NEW_PLACE_VALUE, occurredOn: "2026-08-09" }),
			),
		).toEqual({ drank: false, occurredOn: "2026-08-09" });
	});

	it("場所を選ばずに名前だけ残っていても新規作成しない", () => {
		expect(
			buildCreateEntryEncounterInput(draft({ newPlaceName: "消し忘れ" })),
		).toBeUndefined();
	});

	it("価格・メモも送る(数値にできない価格は送らない)", () => {
		expect(
			buildCreateEntryEncounterInput(draft({ price: "12000", memo: " 一杯 " })),
		).toEqual({ drank: false, price: 12000, memo: "一杯" });
		expect(
			buildCreateEntryEncounterInput(draft({ price: "abc" })),
		).toBeUndefined();
	});
});

describe("buildAddEncounterInput", () => {
	it("空の下書きは drank だけ送る(サーバ側で null になる)", () => {
		expect(buildAddEncounterInput(draft())).toEqual({ drank: false });
	});

	it("入力された項目だけを送る", () => {
		expect(
			buildAddEncounterInput(
				draft({
					drank: true,
					occurredOn: "2026-08-01",
					placeId: "p1",
					rating: 4,
					price: "12000",
					memo: "  棚の一番上  ",
				}),
			),
		).toEqual({
			drank: true,
			occurredOn: "2026-08-01",
			placeId: "p1",
			rating: 4,
			price: 12000,
			memo: "棚の一番上",
		});
	});

	it("空白だけのメモは送らない", () => {
		expect(buildAddEncounterInput(draft({ memo: "   " }))).toEqual({
			drank: false,
		});
	});

	it("新しい場所は newPlace として送る(placeId は送らない)", () => {
		const input = buildAddEncounterInput(
			draft({
				placeId: NEW_PLACE_VALUE,
				newPlaceName: "  ビストロA  ",
				occurredOn: "2026-08-01",
			}),
		);
		expect(input).toEqual({
			drank: false,
			newPlace: { name: "ビストロA" },
			occurredOn: "2026-08-01",
		});
		// placeId と同時に送るとサーバの zod が排他違反で弾く
		expect(input).not.toHaveProperty("placeId");
	});

	it("新しい場所を選んだまま名前が空なら場所の指定なしにする", () => {
		expect(
			buildAddEncounterInput(
				draft({ placeId: NEW_PLACE_VALUE, newPlaceName: "   " }),
			),
		).toEqual({ drank: false });
	});
});

describe("buildUpdateEncounterInput", () => {
	it("空欄は null で送ってクリアする(銘柄・飲用記録と同じ規約)", () => {
		expect(buildUpdateEncounterInput("e1", draft())).toEqual({
			id: "e1",
			drank: false,
			placeId: null,
			occurredOn: null,
			rating: null,
			price: null,
			memo: null,
		});
	});

	it("入力された値をそのまま送る", () => {
		expect(
			buildUpdateEncounterInput(
				"e1",
				draft({
					drank: true,
					occurredOn: "2026-07-31",
					placeId: "p2",
					rating: 5,
					price: "9800",
					memo: "x",
				}),
			),
		).toEqual({
			id: "e1",
			drank: true,
			occurredOn: "2026-07-31",
			placeId: "p2",
			rating: 5,
			price: 9800,
			memo: "x",
		});
	});

	it("トグルOFFに倒すと評価をクリアする(不可視のまま残さない)", () => {
		expect(
			buildUpdateEncounterInput("e1", draft({ drank: false, rating: 4 })),
		).toMatchObject({ id: "e1", drank: false, rating: null });
	});

	it("由来(batchId / photoIndex)は送らない(ユーザが編集する情報ではない)", () => {
		const input = buildUpdateEncounterInput("e1", draft({ placeId: "p1" }));
		expect(input).not.toHaveProperty("batchId");
		expect(input).not.toHaveProperty("photoIndex");
	});

	it("数値にできない価格は null にする(空欄と同じ扱い)", () => {
		expect(buildUpdateEncounterInput("e1", draft({ price: "abc" })).price).toBe(
			null,
		);
	});

	it("新しい場所は newPlace として送る(placeId は送らない)", () => {
		const input = buildUpdateEncounterInput(
			"e1",
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: "  ビストロA  " }),
		);
		expect(input).toMatchObject({
			id: "e1",
			newPlace: { name: "ビストロA" },
		});
		// 採番はサーバ。placeId を同時に送ると zod の排他違反になる
		expect(input).not.toHaveProperty("placeId");
	});

	it("新しい場所を選んだまま名前が空なら場所をクリアする", () => {
		const input = buildUpdateEncounterInput(
			"e1",
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: "   " }),
		);
		expect(input.placeId).toBe(null);
		expect(input).not.toHaveProperty("newPlace");
	});
});
