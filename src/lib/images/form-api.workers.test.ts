import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERSONATION_READONLY_MESSAGE } from "#/lib/admin/impersonation";
import {
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";
import { TOO_MANY_REQUESTS_MESSAGE } from "#/lib/errors";

// requireApiSession の検証だけは better-auth の実セッション(署名済みCookie)が要るため、
// getSession の戻り値だけを差し替える。form-api.ts が持つ判断(未ログイン/なりすまし)を
// 素の Request/Response で確かめるのが目的で、better-auth 自体は検証対象ではない。
const authHooks = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => authHooks.session } },
}));

const {
	API_ERROR_MESSAGES,
	apiJson,
	apiJsonError,
	MAX_FORM_DATA_BYTES,
	readImageFormData,
	requireApiSession,
	validateDeclaredPhotoFile,
	validateDeclaredPhotoFiles,
} = await import("./form-api");

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

beforeEach(() => {
	authHooks.session = null;
});

// 画像APIルート3本(アバター/ワイン写真/エチケット解析)はすべて POST で、すべて
// requireApiSession を通る。なりすまし(impersonation)中にここが素通りすると、管理者の
// 操作で対象ユーザの R2 オブジェクトが書き換わり AI クレジットが減る(#116)。
describe("requireApiSession", () => {
	function postRequest(): Request {
		return new Request("https://wine.test/api/wine-photos", { method: "POST" });
	}

	it("未ログインは 401 の Response を返す", async () => {
		const res = await requireApiSession(postRequest());
		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(401);
		expect(await body(res as Response)).toEqual({
			error: API_ERROR_MESSAGES.unauthorized,
		});
	});

	it("通常のログインセッションはそのまま返す", async () => {
		const session = { user: { id: "u1" }, session: { id: "s1" } };
		authHooks.session = session;

		await expect(requireApiSession(postRequest())).resolves.toBe(session);
	});

	it("なりすまし中の POST は 403 で拒否する", async () => {
		authHooks.session = {
			user: { id: "u1" },
			session: { id: "s1", impersonatedBy: "admin1" },
		};

		const res = await requireApiSession(postRequest());

		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(403);
		expect(await body(res as Response)).toEqual({
			error: IMPERSONATION_READONLY_MESSAGE,
		});
	});

	it("なりすまし中でも GET は通す(閲覧は許可)", async () => {
		const session = {
			user: { id: "u1" },
			session: { id: "s1", impersonatedBy: "admin1" },
		};
		authHooks.session = session;
		const get = new Request("https://wine.test/api/wine-photos");

		await expect(requireApiSession(get)).resolves.toBe(session);
	});

	// #397: 画像アップロードは R2 の書き込み=オーナー負担の従量コストなので、
	// 認証済みでもユーザ単位でスロットルする。上限値は wrangler.jsonc の設定
	// (テストでは vitest.config.ts で少なくしてある)。
	describe("レートリミット (#397)", () => {
		/** テスト間でカウンタを共有しないよう、ユーザIDを毎回変える。 */
		let seq = 0;
		function asUser(): string {
			seq += 1;
			const id = `upload-rl-${seq}`;
			authHooks.session = { user: { id }, session: { id: `s-${id}` } };
			return id;
		}

		it("POST を叩き続けると 429 になる", async () => {
			asUser();
			let limited: Response | undefined;
			for (let i = 0; i < 20 && !limited; i++) {
				const res = await requireApiSession(
					new Request("https://wine.test/api/wine-photos", { method: "POST" }),
				);
				if (res instanceof Response) limited = res;
			}

			expect(limited).toBeInstanceOf(Response);
			if (!limited) return;
			expect(limited.status).toBe(429);
			// 文言は errors.ts の定数を共有する(経路ごとに書き下さない)。
			expect((await body(limited)).error).toBe(TOO_MANY_REQUESTS_MESSAGE);
		});

		it("GET は絞らない(読み取りまで止めると通常利用が先に当たる)", async () => {
			asUser();
			// まず POST で上限を使い切る。
			for (let i = 0; i < 20; i++) {
				await requireApiSession(
					new Request("https://wine.test/api/wine-photos", { method: "POST" }),
				);
			}

			const res = await requireApiSession(
				new Request("https://wine.test/api/wine-photos"),
			);
			expect(res).not.toBeInstanceOf(Response);
		});

		it("ユーザが違えば互いのカウンタに影響しない", async () => {
			asUser();
			for (let i = 0; i < 20; i++) {
				await requireApiSession(
					new Request("https://wine.test/api/wine-photos", { method: "POST" }),
				);
			}

			// 別ユーザに切り替えると通る。
			asUser();
			const res = await requireApiSession(
				new Request("https://wine.test/api/wine-photos", { method: "POST" }),
			);
			expect(res).not.toBeInstanceOf(Response);
		});
	});
});

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

	it("なりすまし拒否の文言は server fn 側と同じ定数を使う(#116)", () => {
		// 画像APIルートと server function は別系統だが、利用者から見れば同じ制約。
		// ここでリテラルを書き下すと片方だけ文言が古くなる。
		expect(API_ERROR_MESSAGES.impersonationReadOnly).toBe(
			IMPERSONATION_READONLY_MESSAGE,
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

// #398: content-length を信用した事前チェックだけでは、ヘッダの無いストリーム送信
// (Transfer-Encoding: chunked)が `Number(null ?? 0)` = 0 で素通りし、本文全体が
// isolate メモリへバッファされた。実バイト数で打ち切ることを固定する。
describe("readImageFormData のサイズ上限(content-length を信用しない・#398)", () => {
	const BOUNDARY = "----formapitest";
	/** 1枚ぶんの上限。上限式は maxFormDataBytes と同じ(定数から導き、リテラルを書かない)。 */
	const ONE_PHOTO_LIMIT = MAX_PHOTO_BYTES * 1 + 64 * 1024;

	/** multipart のボディを「少しずつ」流すストリーム(chunked 送信の再現)。 */
	function multipartStream(payloadBytes: number): ReadableStream<Uint8Array> {
		const enc = new TextEncoder();
		const head = enc.encode(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
		);
		const tail = enc.encode(`\r\n--${BOUNDARY}--\r\n`);
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(head);
			},
			pull(controller) {
				if (sent >= payloadBytes) {
					controller.enqueue(tail);
					controller.close();
					return;
				}
				const size = Math.min(64 * 1024, payloadBytes - sent);
				controller.enqueue(new Uint8Array(size));
				sent += size;
			},
		});
	}

	/** content-length を持たない(=申告の無い)ストリーム POST。 */
	function streamedRequest(payloadBytes: number): Request {
		return new Request("https://wine.test/api/wine-photos", {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
			body: multipartStream(payloadBytes),
			duplex: "half",
		} as RequestInit);
	}

	it("前提: ストリーム送信には content-length が付かない", () => {
		// これが付くなら旧実装でも弾けていたことになり、以下のテストが意味を失う。
		expect(streamedRequest(1024).headers.get("content-length")).toBeNull();
	});

	it("申告が無くても実バイト数が上限を超えたら 413", async () => {
		const res = await readImageFormData(
			streamedRequest(ONE_PHOTO_LIMIT + 1024 * 1024),
			1,
		);
		expect(res).toBeInstanceOf(Response);
		if (!(res instanceof Response)) return;
		expect(res.status).toBe(413);
		expect((await body(res)).error).toBe(API_ERROR_MESSAGES.filesTooLarge);
	});

	it("申告が無くても上限内なら通す(正当な chunked 送信を壊さない)", async () => {
		const res = await readImageFormData(streamedRequest(1024), 1);
		expect(res).toBeInstanceOf(FormData);
		if (!(res instanceof FormData)) return;
		const file = res.get("photo");
		expect(file).toBeInstanceOf(File);
		// 打ち切りストリームを通しても中身が欠けない。
		if (file instanceof File) expect(file.size).toBe(1024);
	});

	// 413 を返すだけでは不十分で、**本文を最後まで読まないこと**が本題(読み切ってしまうなら
	// メモリは同じだけ使われ、OOM 誘発は塞げていない)。送信側が実際に生成したバイト数を
	// 数えて、上限付近で打ち切られていることを確かめる。
	it("上限を超えた本文は最後まで読まない(メモリに載せない)", async () => {
		let produced = 0;
		const enc = new TextEncoder();
		// 100MB 送ろうとするストリーム。打ち切られなければ produced がそこまで伸びる。
		const huge = new ReadableStream<Uint8Array>({
			start(controller) {
				const head = enc.encode(
					`--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
				);
				produced += head.byteLength;
				controller.enqueue(head);
			},
			pull(controller) {
				if (produced >= 100 * 1024 * 1024) {
					controller.close();
					return;
				}
				const chunk = new Uint8Array(64 * 1024);
				produced += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});

		const res = await readImageFormData(
			new Request("https://wine.test/api/wine-photos", {
				method: "POST",
				headers: {
					"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
				},
				body: huge,
				duplex: "half",
			} as RequestInit),
			1,
		);

		expect(res).toBeInstanceOf(Response);
		if (res instanceof Response) expect(res.status).toBe(413);
		// 打ち切りの検知は「上限を超えた次のチャンク」で起きるので多少の行き過ぎは許容する。
		// 100MB を読み切っていないこと(=桁で違うこと)が要点。
		expect(produced).toBeLessThan(ONE_PHOTO_LIMIT * 2);
	});

	it("上限超過とパース不能を取り違えない(超過は 413、壊れた本文は 400)", async () => {
		const broken = await readImageFormData(
			new Request("https://wine.test/api/upload", {
				method: "POST",
				headers: {
					"content-type": `multipart/form-data; boundary=${BOUNDARY}`,
				},
				body: "not a valid multipart body",
			}),
			1,
		);
		expect(broken).toBeInstanceOf(Response);
		if (broken instanceof Response) expect(broken.status).toBe(400);
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
