import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBatchPhotoFiles } from "./rescan-photos";

// 一括登録履歴からの再解析(#427)で保存済み写真を読み直すヘルパーの単体テスト。
// ここが壊れると「抜けた写真に写っていた銘柄だけが黙って落ちた結果」を
// 再解析の結果として見せてしまうので、失敗は必ず throw に落ちることを固定する。

/**
 * fetch の応答を最小限で模す。jsdom の Blob は undici の Response に渡せない
 * (`object.stream is not a function`)ため、実 Response は組み立てずに
 * このヘルパーが読む2つの口(ok / blob)だけを持つオブジェクトを返す。
 */
function photoResponse(type = "image/jpeg"): Response {
	return {
		ok: true,
		blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type }),
	} as unknown as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchBatchPhotoFiles", () => {
	it("URLの順序どおりに File を返す(photoIndex の順を保つ)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => photoResponse()),
		);

		const files = await fetchBatchPhotoFiles([
			"/api/images/wines/u1/b1/a.jpg",
			"/api/images/wines/u1/b1/b.jpg",
		]);

		expect(files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
		expect(files.every((f) => f.type === "image/jpeg")).toBe(true);
	});

	it("Cookie を載せて取得する(署名URLではなく本人セッションで認可する)", async () => {
		const fetchMock = vi.fn(async () => photoResponse());
		vi.stubGlobal("fetch", fetchMock);

		await fetchBatchPhotoFiles(["/api/images/wines/u1/b1/a.jpg"]);

		expect(fetchMock).toHaveBeenCalledWith("/api/images/wines/u1/b1/a.jpg", {
			credentials: "same-origin",
		});
	});

	it("1枚でも取得に失敗したら throw する(欠けたまま解析させない)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.endsWith("b.jpg")
					? ({ ok: false } as unknown as Response)
					: photoResponse(),
			),
		);

		await expect(
			fetchBatchPhotoFiles([
				"/api/images/wines/u1/b1/a.jpg",
				"/api/images/wines/u1/b1/b.jpg",
			]),
		).rejects.toThrow("保存済みの写真を読み込めませんでした");
	});

	it("扱えない形式は throw する(原因が分かる文言にする)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => photoResponse("application/pdf")),
		);

		await expect(
			fetchBatchPhotoFiles(["/api/images/wines/u1/b1/a.pdf"]),
		).rejects.toThrow(/形式を扱えません/);
	});

	it("拡張子が無いURLでも名前を補う", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => photoResponse()),
		);

		const files = await fetchBatchPhotoFiles(["/api/images/wines/u1/b1/photo"]);

		expect(files[0]?.name).toBe("batch-photo-1.jpg");
	});

	it("空配列なら何も取得しない", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchBatchPhotoFiles([])).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
