import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import {
	acceptPhotoFiles,
	detachPhotoFiles,
	PHOTO_UNREADABLE_MESSAGE,
	remainingPhotoSlots,
} from "./photo-picker";

// 再解析(#427)は保存済みの写真が入った状態で始まり、そこへ撮り忘れたページを
// 足せる(#428)。上限判定が「選んだファイルだけ」を見ていると超過するので、
// 「今ある枚数 + これから足す枚数」で見ることをここで固定する。
//
// detachPhotoFiles(#469)は「選んだ瞬間に中身を掴む」ための関門。掴み損ねると
// 保存が `fetch` の TypeError になり、利用者には「通信に失敗しました」としか
// 見えず、サーバ側にはログすら残らない。

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

	it("枚数上限は経路ごとに受け取る", () => {
		// 記録フォーム(6枚)とまとめて登録(10枚)で上限が違う。判定を共有しつつ
		// 枚数だけを引数にすることで、#469 のような後付けが片方に漏れない。
		const files = Array.from({ length: MAX_PHOTOS_PER_IMPORT_BATCH }, (_, i) =>
			jpeg(`${i}.jpg`),
		);
		const entry = acceptPhotoFiles(files, 0, MAX_PHOTOS_PER_ENTRY);
		expect(entry.accepted).toHaveLength(MAX_PHOTOS_PER_ENTRY);
		expect(entry.rejectMessage).toContain(`最大${MAX_PHOTOS_PER_ENTRY}枚`);
		expect(acceptPhotoFiles(files, 0).accepted).toHaveLength(
			MAX_PHOTOS_PER_IMPORT_BATCH,
		);
	});
});

describe("detachPhotoFiles", () => {
	it("中身をメモリへ写し、同じ内容・名前・形式の File を返す", async () => {
		const original = new File([new Uint8Array([1, 2, 3, 4])], "a.jpg", {
			type: "image/jpeg",
			lastModified: 1_700_000_000_000,
		});

		const { accepted, rejectMessage } = await detachPhotoFiles([original]);

		expect(rejectMessage).toBe("");
		expect(accepted).toHaveLength(1);
		const detached = accepted[0];
		if (!detached) throw new Error("unreachable");
		// **元の File を素通ししない**。素通しすると端末側でファイルが回収された
		// ときに送信できなくなる(この関数が存在する理由そのもの)。
		expect(detached).not.toBe(original);
		expect(detached.name).toBe("a.jpg");
		expect(detached.type).toBe("image/jpeg");
		expect(detached.lastModified).toBe(1_700_000_000_000);
		expect(new Uint8Array(await detached.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3, 4]),
		);
	});

	it("元のファイルが読めなくなっても、取り込んだ側は読める", async () => {
		const original = jpeg("a.jpg");
		const { accepted } = await detachPhotoFiles([original]);
		// 端末側でファイルが回収された状態を再現する。
		Object.defineProperty(original, "arrayBuffer", {
			value: () => Promise.reject(new Error("file gone")),
		});

		await expect(accepted[0]?.arrayBuffer()).resolves.toBeDefined();
	});

	it("読めなかったファイルは落とし、回線ではなく選び直しを案内する", async () => {
		const broken = jpeg("gone.jpg");
		Object.defineProperty(broken, "arrayBuffer", {
			value: () => Promise.reject(new Error("file gone")),
		});

		const { accepted, rejectMessage } = await detachPhotoFiles([
			broken,
			jpeg("ok.jpg"),
		]);

		// 読めた分は残す(1枚の失敗で選択ごと捨てない)。
		expect(accepted.map((f) => f.name)).toEqual(["ok.jpg"]);
		expect(rejectMessage).toBe(PHOTO_UNREADABLE_MESSAGE);
		// 「電波」を案内すると、端末側の問題なのに再試行を延々と勧めることになる。
		expect(rejectMessage).not.toContain("電波");
	});

	it("空の選択では何もしない", async () => {
		await expect(detachPhotoFiles([])).resolves.toEqual({
			accepted: [],
			rejectMessage: "",
		});
	});
});

describe("remainingPhotoSlots", () => {
	it("残り枚数を返し、超過しても負にならない", () => {
		expect(remainingPhotoSlots(0)).toBe(MAX_PHOTOS_PER_IMPORT_BATCH);
		expect(remainingPhotoSlots(MAX_PHOTOS_PER_IMPORT_BATCH)).toBe(0);
		expect(remainingPhotoSlots(MAX_PHOTOS_PER_IMPORT_BATCH + 5)).toBe(0);
	});
});
