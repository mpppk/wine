import { describe, expect, it } from "vitest";
import {
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";
import {
	API_ERROR_MESSAGES,
	apiJson,
	apiJsonError,
	MAX_FORM_DATA_BYTES,
	readImageFormData,
	validateDeclaredPhotoFile,
	validateDeclaredPhotoFiles,
} from "./form-api";

// 画像系APIルート3本が通る共通関門の検証(#260)。ここが緩むと3ルート同時に緩む。
// `#/lib/auth` を引き込むため jsdom では読めず、workers プロジェクトに置く
// (隣の authorize.workers.test.ts と同じ理由)。

async function body(res: Response): Promise<{ error?: string }> {
	return (await res.json()) as { error?: string };
}

/** content-length ヘッダだけを持つリクエスト(実ボディは送らない) */
function requestWithContentLength(length: number): Request {
	return new Request("https://wine.test/api/wine-photos", {
		method: "POST",
		headers: { "content-length": String(length) },
		body: "x",
	});
}

describe("apiJson / apiJsonError", () => {
	it("エラーは { error } 形・JSON Content-Type で返す", async () => {
		const res = apiJsonError("boom", 400);
		expect(res.status).toBe(400);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(await body(res)).toEqual({ error: "boom" });
	});

	it("成功応答の既定ステータスは200", async () => {
		const res = apiJson({ ok: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("エラー文言の導出", () => {
	it("上限サイズの文言は定数から組み立てる(リテラル再記述を作らない)", () => {
		// 「5 MB」と書き下すと MAX_PHOTO_BYTES を変えたときに文言だけ旧値で残る
		expect(API_ERROR_MESSAGES.fileTooLarge).toContain(MAX_PHOTO_SIZE_LABEL);
	});

	it("枚数上限の文言も定数から組み立てる", () => {
		expect(API_ERROR_MESSAGES.tooManyPhotos).toContain(
			String(MAX_PHOTOS_PER_ENTRY),
		);
	});
});

describe("readImageFormData", () => {
	it("content-length が上限を超えたら formData を読まずに 413", async () => {
		const res = await readImageFormData(
			requestWithContentLength(MAX_FORM_DATA_BYTES + 1),
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(413);
		expect((await body(res)).error).toBe(API_ERROR_MESSAGES.filesTooLarge);
	});

	it("上限ちょうどは通す(境界)", async () => {
		// 上限ちょうどで弾くと、最大枚数を送ったときに常に失敗する
		const form = new FormData();
		form.set("photo", new File(["x"], "a.jpg", { type: "image/jpeg" }));
		const req = new Request("https://wine.test/api/wine-photos", {
			method: "POST",
			body: form,
		});
		// content-length は FormData から自動計算されるので、上限ちょうどの
		// ヘッダを明示的に被せて境界だけを見る
		const bounded = new Request(req, {
			headers: {
				...Object.fromEntries(req.headers),
				"content-length": String(MAX_FORM_DATA_BYTES),
			},
		});
		const res = await readImageFormData(bounded);
		expect(res).toBeInstanceOf(FormData);
	});

	it("パースできないボディは 400", async () => {
		const req = new Request("https://wine.test/api/upload", {
			method: "POST",
			headers: { "content-type": "multipart/form-data; boundary=----nope" },
			body: "not a valid multipart body",
		});
		const res = await readImageFormData(req);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(400);
		expect((await body(res)).error).toBe(API_ERROR_MESSAGES.invalidFormData);
	});

	it("正常な multipart は FormData を返す", async () => {
		const form = new FormData();
		form.set("photo", new File(["x"], "a.jpg", { type: "image/jpeg" }));
		const res = await readImageFormData(
			new Request("https://wine.test/api/wine-photos", {
				method: "POST",
				body: form,
			}),
		);
		expect(res).toBeInstanceOf(FormData);
	});
});

describe("validateDeclaredPhotoFile", () => {
	it("許可外の申告MIMEは 400", async () => {
		const res = validateDeclaredPhotoFile(
			new File(["x"], "a.svg", { type: "image/svg+xml" }),
		);
		expect(res?.status).toBe(400);
		if (res) {
			expect((await body(res)).error).toBe(
				API_ERROR_MESSAGES.unsupportedImageType,
			);
		}
	});

	it("上限超過のサイズは 400", async () => {
		const big = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], "a.jpg", {
			type: "image/jpeg",
		});
		const res = validateDeclaredPhotoFile(big);
		expect(res?.status).toBe(400);
		if (res) {
			expect((await body(res)).error).toBe(API_ERROR_MESSAGES.fileTooLarge);
		}
	});

	it("許可MIME・上限内なら null(通過)", () => {
		expect(
			validateDeclaredPhotoFile(
				new File(["x"], "a.jpg", { type: "image/jpeg" }),
			),
		).toBeNull();
	});

	it("複数ファイル版は1つでも不正なら弾く", () => {
		const ok = new File(["x"], "a.jpg", { type: "image/jpeg" });
		const ng = new File(["x"], "a.svg", { type: "image/svg+xml" });
		expect(validateDeclaredPhotoFiles([ok, ok])).toBeNull();
		expect(validateDeclaredPhotoFiles([ok, ng])?.status).toBe(400);
	});
});
