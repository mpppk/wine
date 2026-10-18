import { describe, expect, it } from "vitest";
import {
	defaultPhotoBox,
	growPhotoBox,
	movePhotoBox,
	normalizePhotoBox,
	normalizePhotoBoxEntries,
	PHOTO_BOX_MIN_SIZE,
	type PhotoBox,
	photoBoxEntriesSchema,
	photoBoxFocusRect,
	photoBoxForIndex,
	photoBoxSchema,
	resizePhotoBox,
	setPhotoBoxForIndex,
} from "./photo-box";

const BOX: PhotoBox = { top: 0.2, bottom: 0.4, left: 0.1, right: 0.3 };

describe("normalizePhotoBox", () => {
	it("有効な枠はそのまま返す", () => {
		expect(normalizePhotoBox(BOX)).toEqual(BOX);
	});

	it("範囲外は 0〜1 に収め、辺の向きが逆なら入れ替える(Jev の出力の揺れ)", () => {
		expect(
			normalizePhotoBox({ top: 0.8, bottom: -0.1, left: 1.2, right: 0.5 }),
		).toEqual({ top: 0, bottom: 0.8, left: 0.5, right: 1 });
	});

	it("小数4桁に丸める(JSON を短く保つ)", () => {
		expect(
			normalizePhotoBox({
				top: 0.123456,
				bottom: 0.5,
				left: 0.1,
				right: 0.333333,
			}),
		).toEqual({ top: 0.1235, bottom: 0.5, left: 0.1, right: 0.3333 });
	});

	it("数値でない・欠けている・小さすぎる枠は null(throw しない)", () => {
		expect(normalizePhotoBox(null)).toBeNull();
		expect(normalizePhotoBox("box")).toBeNull();
		expect(normalizePhotoBox({ top: 0.1, bottom: 0.2, left: 0.1 })).toBeNull();
		expect(
			normalizePhotoBox({ top: "0.1", bottom: 0.2, left: 0.1, right: 0.2 }),
		).toBeNull();
		expect(
			normalizePhotoBox({
				top: Number.NaN,
				bottom: 0.2,
				left: 0.1,
				right: 0.2,
			}),
		).toBeNull();
		expect(
			normalizePhotoBox({ top: 0.1, bottom: 0.11, left: 0.1, right: 0.5 }),
		).toBeNull();
	});
});

describe("normalizePhotoBoxEntries", () => {
	it("壊れた行・範囲外の番号を落とし、同じ番号は先勝ちで番号順に並べる", () => {
		const second: PhotoBox = { top: 0, bottom: 1, left: 0, right: 1 };
		expect(
			normalizePhotoBoxEntries(
				[
					{ photoIndex: 2, box: BOX },
					{ photoIndex: 0, box: second },
					{ photoIndex: 2, box: second },
					{ photoIndex: 1.5, box: BOX },
					{ photoIndex: -1, box: BOX },
					{ photoIndex: 5, box: BOX },
					{ photoIndex: 3, box: { top: 1 } },
					"junk",
				],
				4,
			),
		).toEqual([
			{ photoIndex: 0, box: second },
			{ photoIndex: 2, box: BOX },
		]);
	});

	it("配列でなければ空配列(DB の NULL・旧行)", () => {
		expect(normalizePhotoBoxEntries(null)).toEqual([]);
		expect(normalizePhotoBoxEntries({ photoIndex: 0, box: BOX })).toEqual([]);
	});
});

describe("photoBoxSchema / photoBoxEntriesSchema", () => {
	it("範囲外・小さすぎる・向きが逆の枠を弾く", () => {
		expect(photoBoxSchema.safeParse(BOX).success).toBe(true);
		expect(photoBoxSchema.safeParse({ ...BOX, right: 1.1 }).success).toBe(
			false,
		);
		expect(
			photoBoxSchema.safeParse({ ...BOX, bottom: BOX.top + 0.001 }).success,
		).toBe(false);
		expect(
			photoBoxSchema.safeParse({ ...BOX, left: 0.5, right: 0.3 }).success,
		).toBe(false);
	});

	it("最小サイズちょうどの枠は通す(エディタが縮められる下限と一致させる)", () => {
		expect(
			photoBoxSchema.safeParse({
				top: 0.1,
				bottom: 0.1 + PHOTO_BOX_MIN_SIZE,
				left: 0.5,
				right: 0.5 + PHOTO_BOX_MIN_SIZE,
			}).success,
		).toBe(true);
	});

	it("同じ写真に2つの枠・番号の上限超えを弾く", () => {
		const schema = photoBoxEntriesSchema(2);
		expect(
			schema.safeParse([
				{ photoIndex: 0, box: BOX },
				{ photoIndex: 2, box: BOX },
			]).success,
		).toBe(true);
		expect(
			schema.safeParse([
				{ photoIndex: 0, box: BOX },
				{ photoIndex: 0, box: BOX },
			]).success,
		).toBe(false);
		expect(schema.safeParse([{ photoIndex: 3, box: BOX }]).success).toBe(false);
	});
});

describe("photoBoxForIndex / setPhotoBoxForIndex", () => {
	it("番号で引き、差し替え・削除しても番号順を保つ", () => {
		const entries = [
			{ photoIndex: 0, box: BOX },
			{ photoIndex: 3, box: BOX },
		];
		expect(photoBoxForIndex(entries, 3)).toEqual(BOX);
		expect(photoBoxForIndex(entries, 1)).toBeNull();
		expect(photoBoxForIndex(undefined, 0)).toBeNull();
		const added = setPhotoBoxForIndex(entries, 1, defaultPhotoBox());
		expect(added.map((e) => e.photoIndex)).toEqual([0, 1, 3]);
		expect(
			setPhotoBoxForIndex(added, 0, null).map((e) => e.photoIndex),
		).toEqual([1, 3]);
	});
});

describe("photoBoxFocusRect", () => {
	const size = { width: 4000, height: 3000 };

	it("枠の周りに余白を足し、タイルの縦横比(正方形)に合わせる", () => {
		const box: PhotoBox = { top: 0.4, bottom: 0.5, left: 0.45, right: 0.5 };
		const rect = photoBoxFocusRect(box, size);
		expect(rect.width).toBeCloseTo(rect.height);
		// 枠(200×300px)が領域に収まり、中心が枠の中心に合う
		expect(rect.x).toBeLessThanOrEqual(0.45 * 4000);
		expect(rect.x + rect.width).toBeGreaterThanOrEqual(0.5 * 4000);
		expect(rect.y).toBeLessThanOrEqual(0.4 * 3000);
		expect(rect.y + rect.height).toBeGreaterThanOrEqual(0.5 * 3000);
		expect(rect.x + rect.width / 2).toBeCloseTo(0.475 * 4000);
	});

	it("画像の端の枠は縮めずにずらして画像内に収める", () => {
		const box: PhotoBox = { top: 0, bottom: 0.1, left: 0.9, right: 1 };
		const rect = photoBoxFocusRect(box, size);
		expect(rect.x + rect.width).toBeCloseTo(4000);
		expect(rect.y).toBe(0);
	});

	it("画像より大きくなる領域は画像の大きさまでに収める", () => {
		const box: PhotoBox = { top: 0, bottom: 1, left: 0, right: 1 };
		const rect = photoBoxFocusRect(box, size);
		expect(rect.width).toBeLessThanOrEqual(4000);
		expect(rect.height).toBeLessThanOrEqual(3000);
		expect(rect.x).toBeGreaterThanOrEqual(0);
		expect(rect.y).toBeGreaterThanOrEqual(0);
	});
});

describe("エディタの幾何", () => {
	it("movePhotoBox は大きさを保ったまま画像内で止める", () => {
		expect(movePhotoBox(BOX, 0.1, 0.1)).toEqual({
			top: 0.3,
			bottom: 0.5,
			left: 0.2,
			right: 0.4,
		});
		expect(movePhotoBox(BOX, -1, 5)).toEqual({
			top: 0.8,
			bottom: 1,
			left: 0,
			right: 0.2,
		});
	});

	it("resizePhotoBox は向かいの角を固定し、裏返らず最小サイズを保つ", () => {
		expect(resizePhotoBox(BOX, "bottom-right", 0.6, 0.9)).toEqual({
			...BOX,
			bottom: 0.9,
			right: 0.6,
		});
		// 向かいの角の反対側まで引っ張っても裏返らない
		const flipped = resizePhotoBox(BOX, "top-left", 0.9, 0.9);
		expect(flipped.right - flipped.left).toBeCloseTo(PHOTO_BOX_MIN_SIZE);
		expect(flipped.bottom - flipped.top).toBeCloseTo(PHOTO_BOX_MIN_SIZE);
		expect(flipped.right).toBe(BOX.right);
		expect(flipped.bottom).toBe(BOX.bottom);
		// 画像の外は 0〜1 に収める
		expect(resizePhotoBox(BOX, "top-right", 2, -1)).toEqual({
			...BOX,
			top: 0,
			right: 1,
		});
	});

	it("growPhotoBox は右下を広げ縮めする(キー操作)", () => {
		expect(growPhotoBox(BOX, 0.05, -0.05)).toEqual({
			...BOX,
			right: 0.35,
			bottom: 0.35,
		});
	});

	it("既定の枠はスキーマを満たす", () => {
		expect(photoBoxSchema.safeParse(defaultPhotoBox()).success).toBe(true);
	});
});
