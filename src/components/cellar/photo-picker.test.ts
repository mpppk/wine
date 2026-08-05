import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES } from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { acceptPhotoFiles, remainingPhotoSlots } from "./photo-picker";

// 再解析(#427)は保存済みの写真が入った状態で始まり、そこへ撮り忘れたページを
// 足せる(#428)。上限判定が「選んだファイルだけ」を見ていると超過するので、
// 「今ある枚数 + これから足す枚数」で見ることをここで固定する。

function jpeg(name: string, size = 1000): File {
	const file = new File([new Uint8Array(1)], name, { type: "image/jpeg" });
	Object.defineProperty(file, "size", { value: size });
	return file;
}

describe("acceptPhotoFiles", () => {
	it("形式・サイズが妥当なら選択順にすべて受け入れる", () => {
		const { accepted, rejectMessage } = acceptPhotoFiles(
			[jpeg("a.jpg"), jpeg("b.jpg")],
			0,
		);
		expect(accepted.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
		expect(rejectMessage).toBe("");
	});

	it("既に選択済みの枚数を含めて上限で打ち切る", () => {
		const { accepted, rejectMessage } = acceptPhotoFiles(
			[jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")],
			MAX_PHOTOS_PER_IMPORT_BATCH - 1,
		);
		expect(accepted.map((f) => f.name)).toEqual(["a.jpg"]);
		expect(rejectMessage).toContain(`最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚`);
	});

	it("既に上限まで選択済みなら1枚も受け入れない", () => {
		const { accepted, rejectMessage } = acceptPhotoFiles(
			[jpeg("a.jpg")],
			MAX_PHOTOS_PER_IMPORT_BATCH,
		);
		expect(accepted).toEqual([]);
		expect(rejectMessage).not.toBe("");
	});

	it("対応していない形式は弾き、他は受け入れる", () => {
		const pdf = new File([new Uint8Array(1)], "x.pdf", {
			type: "application/pdf",
		});
		const { accepted, rejectMessage } = acceptPhotoFiles(
			[pdf, jpeg("a.jpg")],
			0,
		);
		expect(accepted.map((f) => f.name)).toEqual(["a.jpg"]);
		expect(rejectMessage).toContain("対応していない画像形式");
	});

	it("サイズ超過は弾く", () => {
		const { accepted, rejectMessage } = acceptPhotoFiles(
			[jpeg("big.jpg", MAX_PHOTO_BYTES + 1)],
			0,
		);
		expect(accepted).toEqual([]);
		expect(rejectMessage).toContain("以下にしてください");
	});
});

describe("remainingPhotoSlots", () => {
	it("残り枚数を返し、超過しても負にならない", () => {
		expect(remainingPhotoSlots(0)).toBe(MAX_PHOTOS_PER_IMPORT_BATCH);
		expect(remainingPhotoSlots(MAX_PHOTOS_PER_IMPORT_BATCH)).toBe(0);
		expect(remainingPhotoSlots(MAX_PHOTOS_PER_IMPORT_BATCH + 5)).toBe(0);
	});
});
