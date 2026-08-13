import { describe, expect, it } from "vitest";
import type { WineSightingEntry } from "#/lib/services/drunk-wine-service";
import { NEW_PLACE_VALUE, type WineSightingDraft } from "./SightingFields";
import {
	buildAddSightingInput,
	buildCreateEntrySightingInput,
	buildUpdateSightingInput,
	draftFromLabelJobSighting,
	draftFromSighting,
} from "./sighting-payload";

function sighting(partial: Partial<WineSightingEntry> = {}): WineSightingEntry {
	return {
		id: "s1",
		placeId: null,
		placeName: null,
		batchId: null,
		photoIndex: null,
		photoUrl: null,
		seenOn: null,
		price: null,
		memo: null,
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

function draft(partial: Partial<WineSightingDraft> = {}): WineSightingDraft {
	return {
		placeId: "",
		newPlaceName: "",
		seenOn: "",
		price: "",
		memo: "",
		...partial,
	};
}

describe("draftFromSighting", () => {
	it("null をフォームの空欄に写す", () => {
		expect(draftFromSighting(sighting())).toEqual({
			placeId: "",
			newPlaceName: "",
			seenOn: "",
			price: "",
			memo: "",
		});
	});

	it("保存済みの値をフォームに戻す(価格は文字列)", () => {
		expect(
			draftFromSighting(
				sighting({
					placeId: "p1",
					seenOn: "2026-08-01",
					price: 12000,
					memo: "グラスでも提供",
				}),
			),
		).toEqual({
			placeId: "p1",
			newPlaceName: "",
			seenOn: "2026-08-01",
			price: "12000",
			memo: "グラスでも提供",
		});
	});
});

// 解析を投げて離脱した回の復元(#498)。ジョブに残した内容をフォーム値へ戻す。
describe("draftFromLabelJobSighting", () => {
	it("既存の場所と見かけた日を戻す", () => {
		expect(
			draftFromLabelJobSighting({ placeId: "p1", seenOn: "2026-08-09" }),
		).toEqual(draft({ placeId: "p1", seenOn: "2026-08-09" }));
	});

	it("新しい場所は「新しい場所を追加…」の選択状態で戻す(place はまだ無い)", () => {
		expect(draftFromLabelJobSighting({ newPlaceName: "ビストロ" })).toEqual(
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: "ビストロ" }),
		);
	});

	it("見かけた日だけの回も戻せる", () => {
		expect(draftFromLabelJobSighting({ seenOn: "2026-08-09" })).toEqual(
			draft({ seenOn: "2026-08-09" }),
		);
	});

	// 復元 → 送信で往復しても同じ内容になること(ここがズレると、受け取った回だけ
	// 場所が落ちる・二重に場所が増える、が静かに起きる)
	it("復元した下書きは、そのまま作成入力へ戻せる", () => {
		expect(
			buildCreateEntrySightingInput(
				draftFromLabelJobSighting({
					newPlaceName: "ビストロ",
					seenOn: "2026-08-09",
				}),
			),
		).toEqual({ newPlace: { name: "ビストロ" }, seenOn: "2026-08-09" });
	});
});

// 銘柄の新規作成に添える目撃記録(#495)。写真から登録した回の「見かけた場所・
// 見かけた日」がここを通ってサーバへ渡る。
describe("buildCreateEntrySightingInput", () => {
	it("全欄が空なら記録を作らない(undefined)", () => {
		expect(buildCreateEntrySightingInput(draft())).toBeUndefined();
	});

	it("既存の場所と見かけた日を送る", () => {
		expect(
			buildCreateEntrySightingInput(
				draft({ placeId: "p1", seenOn: "2026-08-09" }),
			),
		).toEqual({ placeId: "p1", seenOn: "2026-08-09" });
	});

	it("新規の場所は newPlace として送る(placeId は送らない)", () => {
		const input = buildCreateEntrySightingInput(
			draft({ placeId: NEW_PLACE_VALUE, newPlaceName: " ビストロ " }),
		);
		expect(input).toEqual({ newPlace: { name: "ビストロ" } });
		expect(input).not.toHaveProperty("placeId");
	});

	it("新規の場所を選んで名前が空なら、場所なしの記録にする", () => {
		expect(
			buildCreateEntrySightingInput(
				draft({ placeId: NEW_PLACE_VALUE, seenOn: "2026-08-09" }),
			),
		).toEqual({ seenOn: "2026-08-09" });
	});

	it("場所を選ばずに名前だけ残っていても新規作成しない", () => {
		expect(
			buildCreateEntrySightingInput(draft({ newPlaceName: "消し忘れ" })),
		).toBeUndefined();
	});

	it("価格・メモも送る(数値にできない価格は送らない)", () => {
		expect(
			buildCreateEntrySightingInput(draft({ price: "12000", memo: " 一杯 " })),
		).toEqual({ price: 12000, memo: "一杯" });
		expect(
			buildCreateEntrySightingInput(draft({ price: "abc" })),
		).toBeUndefined();
	});
});

describe("buildAddSightingInput", () => {
	it("空欄のフィールドは送らない(サーバ側で null になる)", () => {
		expect(buildAddSightingInput(draft())).toEqual({});
	});

	it("入力された項目だけを送る", () => {
		expect(
			buildAddSightingInput(
				draft({
					placeId: "p1",
					seenOn: "2026-08-01",
					price: "12000",
					memo: "  棚の一番上  ",
				}),
			),
		).toEqual({
			placeId: "p1",
			seenOn: "2026-08-01",
			price: 12000,
			memo: "棚の一番上",
		});
	});

	it("空白だけのメモは送らない", () => {
		expect(buildAddSightingInput(draft({ memo: "   " }))).toEqual({});
	});
});

describe("buildUpdateSightingInput", () => {
	it("空欄は null で送ってクリアする(銘柄・飲用記録と同じ規約)", () => {
		expect(buildUpdateSightingInput("s1", draft())).toEqual({
			id: "s1",
			placeId: null,
			seenOn: null,
			price: null,
			memo: null,
		});
	});

	it("入力された値をそのまま送る", () => {
		expect(
			buildUpdateSightingInput(
				"s1",
				draft({
					placeId: "p2",
					seenOn: "2026-07-31",
					price: "9800",
					memo: "x",
				}),
			),
		).toEqual({
			id: "s1",
			placeId: "p2",
			seenOn: "2026-07-31",
			price: 9800,
			memo: "x",
		});
	});

	it("由来(batchId / photoIndex)は送らない(ユーザが編集する情報ではない)", () => {
		const input = buildUpdateSightingInput("s1", draft({ placeId: "p1" }));
		expect(input).not.toHaveProperty("batchId");
		expect(input).not.toHaveProperty("photoIndex");
	});

	it("数値にできない価格は null にする(空欄と同じ扱い)", () => {
		expect(buildUpdateSightingInput("s1", draft({ price: "abc" })).price).toBe(
			null,
		);
	});
});
