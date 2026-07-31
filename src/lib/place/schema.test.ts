import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE_KIND, PLACE_KIND_IDS, PLACE_KINDS } from "./place";
import {
	createPlaceInput,
	createWineSightingInput,
	MAX_PHOTOS_PER_IMPORT_BATCH,
	PLACE_MEMO_MAX,
	PLACE_NAME_MAX,
	SIGHTING_MEMO_MAX,
	updatePlaceInput,
	updateWineSightingInput,
} from "./schema";

describe("PLACE_KINDS", () => {
	it("既定の区分がレジストリに含まれる(マイグレーションのDEFAULTと対応する)", () => {
		expect(PLACE_KIND_IDS).toContain(DEFAULT_PLACE_KIND);
	});

	it("idが重複しない", () => {
		expect(new Set(PLACE_KIND_IDS).size).toBe(PLACE_KINDS.length);
	});
});

describe("createPlaceInput", () => {
	it("名前だけで作れる(区分・メモは任意)", () => {
		const r = createPlaceInput.safeParse({ name: "ワインバー中目黒" });
		expect(r.success).toBe(true);
	});

	it("名前は空白のみを弾き、前後の空白を落とす", () => {
		expect(createPlaceInput.safeParse({ name: "   " }).success).toBe(false);
		const r = createPlaceInput.safeParse({ name: " 酒屋 " });
		expect(r.success && r.data.name).toBe("酒屋");
	});

	it("名前・メモの上限を超えると弾く", () => {
		expect(
			createPlaceInput.safeParse({ name: "a".repeat(PLACE_NAME_MAX + 1) })
				.success,
		).toBe(false);
		expect(
			createPlaceInput.safeParse({
				name: "店",
				memo: "a".repeat(PLACE_MEMO_MAX + 1),
			}).success,
		).toBe(false);
	});

	it("未知の区分を弾く", () => {
		expect(
			createPlaceInput.safeParse({ name: "店", kind: "bar" }).success,
		).toBe(false);
	});
});

describe("updatePlaceInput", () => {
	it("idだけでも通る(何も変更しない)", () => {
		expect(updatePlaceInput.safeParse({ id: "p1" }).success).toBe(true);
	});

	it("memo は null でクリアできるが、kind は NOT NULL 列なのでクリアできない", () => {
		expect(updatePlaceInput.safeParse({ id: "p1", memo: null }).success).toBe(
			true,
		);
		expect(updatePlaceInput.safeParse({ id: "p1", kind: null }).success).toBe(
			false,
		);
	});
});

describe("createWineSightingInput", () => {
	it("何も指定しなくても通る(「見かけた」だけの記録が作れる)", () => {
		expect(createWineSightingInput.safeParse({}).success).toBe(true);
	});

	it("見かけた日は実在する暦日だけを通す", () => {
		expect(
			createWineSightingInput.safeParse({ seenOn: "2026-07-31" }).success,
		).toBe(true);
		expect(
			createWineSightingInput.safeParse({ seenOn: "2026-02-31" }).success,
		).toBe(false);
		expect(
			createWineSightingInput.safeParse({ seenOn: "2026/07/31" }).success,
		).toBe(false);
	});

	it("photoIndex はバッチの写真枚数の範囲に収める", () => {
		expect(createWineSightingInput.safeParse({ photoIndex: 0 }).success).toBe(
			true,
		);
		expect(
			createWineSightingInput.safeParse({
				photoIndex: MAX_PHOTOS_PER_IMPORT_BATCH - 1,
			}).success,
		).toBe(true);
		expect(
			createWineSightingInput.safeParse({
				photoIndex: MAX_PHOTOS_PER_IMPORT_BATCH,
			}).success,
		).toBe(false);
		expect(createWineSightingInput.safeParse({ photoIndex: -1 }).success).toBe(
			false,
		);
	});

	it("価格は非負整数のみ", () => {
		expect(createWineSightingInput.safeParse({ price: 0 }).success).toBe(true);
		expect(createWineSightingInput.safeParse({ price: -1 }).success).toBe(
			false,
		);
		expect(createWineSightingInput.safeParse({ price: 1.5 }).success).toBe(
			false,
		);
	});

	it("メモの上限を超えると弾く", () => {
		expect(
			createWineSightingInput.safeParse({
				memo: "a".repeat(SIGHTING_MEMO_MAX + 1),
			}).success,
		).toBe(false);
	});
});

describe("updateWineSightingInput", () => {
	it("すべての任意フィールドが null でクリアできる", () => {
		const r = updateWineSightingInput.safeParse({
			id: "s1",
			placeId: null,
			batchId: null,
			photoIndex: null,
			seenOn: null,
			price: null,
			memo: null,
		});
		expect(r.success).toBe(true);
	});
});
