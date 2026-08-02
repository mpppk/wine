import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PHOTO_BYTES } from "#/lib/drunk-wine/photo";
import {
	formDataBytes,
	NETWORK_ERROR_MESSAGE,
	postImageForm,
} from "./form-client";

// クライアント側の画像POST関門。ここが担保するのは「失敗時に必ずユーザへ見せられる
// 日本語の message を持つ Error になる」こと(#358 の実機で "Failed to fetch" が
// そのまま画面に出た)。

/** 指定バイト数の画像ファイル(中身は問わない)。 */
function photoFile(bytes: number, name = "photo.jpg"): File {
	return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

function formWith(...files: File[]): FormData {
	const form = new FormData();
	form.append("entryId", "e1");
	for (const file of files) form.append("photo", file);
	return form;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("formDataBytes", () => {
	it("File/Blob の合計だけを数え、文字列フィールドは無視する", () => {
		expect(formDataBytes(formWith(photoFile(100), photoFile(50)))).toBe(150);
	});

	it("ファイルが無ければ0", () => {
		expect(formDataBytes(new FormData())).toBe(0);
	});
});

describe("postImageForm", () => {
	it("上限を超える合計サイズは送信せずに落とす", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postImageForm(
				"/api/wine-photos",
				formWith(photoFile(MAX_PHOTO_BYTES * 7)),
				{
					fallbackMessage: "失敗しました",
				},
			),
		).rejects.toThrow(/写真の合計サイズが大きすぎて送信できません/);
		// 送り切れないと分かっているリクエストは投げない(413すら返らずに切れるため)
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("枚数上限が大きい経路では、その枚数ぶんの合計まで通す", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postImageForm(
				"/api/wine-list-analysis",
				formWith(photoFile(MAX_PHOTO_BYTES * 7)),
				{ fallbackMessage: "失敗しました", maxPhotos: 10 },
			),
		).resolves.toEqual({ ok: true });
	});

	it("レスポンスが返らない通信失敗は、行動できる日本語に置き換える", async () => {
		// ブラウザの生の TypeError("Failed to fetch") をそのまま出さない
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(
			postImageForm("/api/label-analysis", formWith(photoFile(10)), {
				fallbackMessage: "エチケットの解析に失敗しました",
			}),
		).rejects.toThrow(NETWORK_ERROR_MESSAGE);
		// 切り分けのため原因はコンソールに残す
		expect(consoleError).toHaveBeenCalled();
	});

	it("エラー応答の error をそのまま伝える", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: "写真は最大10枚までです" }), {
					status: 400,
				}),
			),
		);

		await expect(
			postImageForm("/api/wine-list-analysis", formWith(photoFile(10)), {
				fallbackMessage: "写真の解析に失敗しました",
			}),
		).rejects.toThrow("写真は最大10枚までです");
	});

	it("JSONでないエラー応答は fallback に落とす", async () => {
		// フレームワークの汎用500やCloudflareのエラーページ。res.json() の SyntaxError
		// ("Unexpected token '<'")をユーザに見せない
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(new Response("<html>500</html>", { status: 500 })),
		);

		await expect(
			postImageForm("/api/upload", formWith(photoFile(10)), {
				fallbackMessage: "アップロードに失敗しました。",
			}),
		).rejects.toThrow("アップロードに失敗しました。");
	});

	it("200 でも本文がJSONでなければ fallback に落とす", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("")));

		await expect(
			postImageForm("/api/upload", formWith(photoFile(10)), {
				fallbackMessage: "アップロードに失敗しました。",
			}),
		).rejects.toThrow("アップロードに失敗しました。");
	});

	it("成功時はパース済みの本文を返す", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ blocked: false, candidates: [] })),
				),
		);

		await expect(
			postImageForm("/api/wine-list-analysis", formWith(photoFile(10)), {
				fallbackMessage: "写真の解析に失敗しました",
			}),
		).resolves.toEqual({ blocked: false, candidates: [] });
	});
});
