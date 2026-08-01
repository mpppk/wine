import { describe, expect, it } from "vitest";
import type { WineSightingEntry } from "#/lib/services/drunk-wine-service";
import type { WineSightingDraft } from "./SightingFields";
import {
	buildAddSightingInput,
	buildUpdateSightingInput,
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
	return { placeId: "", seenOn: "", price: "", memo: "", ...partial };
}

describe("draftFromSighting", () => {
	it("null をフォームの空欄に写す", () => {
		expect(draftFromSighting(sighting())).toEqual({
			placeId: "",
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
			seenOn: "2026-08-01",
			price: "12000",
			memo: "グラスでも提供",
		});
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
