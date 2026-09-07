import { env } from "cloudflare:workers";
import { parseUserInput } from "better-auth/db";
import { beforeAll, describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";

// preferredAiModel の書き込み経路の検証(#256)。
//
// `authClient.updateUser({ preferredAiModel })` は better-auth のハンドラ直結で、
// アプリ側の zod(server fn の inputValidator)を一切通らない。additionalFields に
// validator が無いと、認証済みユーザが自分の user 行へ任意長の文字列を保存できる。
//
// 検証は2段構え:
//  - 拒否経路は `parseUserInput(auth.options, ...)` を直接呼ぶ。update-user
//    エンドポイントが値を D1 に書く前に必ず通す関門そのもの
//    (better-auth の api/routes/update-user.mjs)で、**このアプリの auth.options を
//    渡す**ため「validator が実際に配線されているか」を見る。エンドポイント経由で
//    400 を起こすと better-auth が APIError を unhandled rejection としても吐き、
//    テストランが汚れる(auth.workers.test.ts でも同じ理由で資格情報エラーを避けている)。
//  - 許可経路は実D1(miniflare)上で `auth.handler` にサインアップ〜update-user を
//    通し、値が実際に user 行へ書かれることまで確かめる。
//
// 単体テスト(config.test.ts)はスキーマ自体の正しさしか示せないため、こちらで配線を押さえる。

const BASE_URL = "http://localhost:3000";
const EMAIL = "preferred-ai-model@example.com";
const PASSWORD = "test-password-256";

let cookie = "";
let userId = "";

/** サインアップし、以降のリクエストで使うセッションクッキーを得る */
beforeAll(async () => {
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({
				name: "preferred ai model",
				email: EMAIL,
				password: PASSWORD,
			}),
		}),
	);
	expect(res.status).toBe(200);
	// Set-Cookie は複数行になりうるため、name=value 部分だけを連結する
	cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	expect(cookie).not.toBe("");

	const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
		.bind(EMAIL)
		.first<{ id: string }>();
	userId = row?.id ?? "";
	expect(userId).not.toBe("");
});

/** update-user を叩く(プロフィール画面の authClient.updateUser と同じ経路) */
function updateUser(body: Record<string, unknown>): Promise<Response> {
	return auth.handler(
		new Request(`${BASE_URL}/api/auth/update-user`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: BASE_URL,
				cookie,
			},
			body: JSON.stringify(body),
		}),
	);
}

/** D1 に保存されている preferredAiModel の生値 */
async function storedModel(): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT preferred_ai_model AS m FROM user WHERE id = ?",
	)
		.bind(userId)
		.first<{ m: string | null }>();
	return row?.m ?? null;
}

/** D1 に保存されている user.locale の生値 */
async function storedLocale(): Promise<string | null> {
	const row = await env.DB.prepare("SELECT locale FROM user WHERE id = ?")
		.bind(userId)
		.first<{ locale: string | null }>();
	return row?.locale ?? null;
}

function signInWithoutCookie(): Promise<Response> {
	return auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
		}),
	);
}

/** update-user が D1 へ書く前に通す関門。拒否時は APIError(400) を投げる */
function parseUpdate(body: Record<string, unknown>): {
	status?: number;
	message?: string;
	parsed?: Record<string, unknown>;
} {
	try {
		return { parsed: parseUserInput(auth.options, body, "update") };
	} catch (e) {
		const err = e as { statusCode?: number; body?: { message?: string } };
		if (typeof err.statusCode !== "number") throw e;
		return { status: err.statusCode, message: err.body?.message };
	}
}

describe("preferredAiModel の書き込みは許可リストで検証される (#256)", () => {
	it("許可リストのキーは D1 に保存される", async () => {
		const res = await updateUser({ preferredAiModel: "llama4" });
		expect(res.status).toBe(200);
		expect(await storedModel()).toBe("llama4");
	});

	it("許可リスト外の文字列は 400 で弾かれ、書き込み値に載らない", () => {
		const result = parseUpdate({ preferredAiModel: "gpt-4" });
		expect(result.status).toBe(400);
		expect(result.parsed).toBeUndefined();
	});

	it("巨大な文字列は 400 で弾かれる(ストレージ肥大の防止)", () => {
		const result = parseUpdate({ preferredAiModel: "a".repeat(300_000) });
		expect(result.status).toBe(400);
		expect(result.parsed).toBeUndefined();
	});

	it("拒否時のメッセージは利用者向けの日本語(プロフィール画面にそのまま出る)", () => {
		expect(parseUpdate({ preferredAiModel: "gpt-4" }).message).toBe(
			"対応していないAIモデルです。",
		);
	});

	it("許可リストのキーは関門を素通りする", () => {
		expect(parseUpdate({ preferredAiModel: "gemma4" }).parsed).toEqual({
			preferredAiModel: "gemma4",
		});
	});

	it("preferredAiModel 以外の更新(name)は従来どおり通る", async () => {
		const res = await updateUser({ name: "renamed" });
		expect(res.status).toBe(200);
		const row = await env.DB.prepare("SELECT name FROM user WHERE id = ?")
			.bind(userId)
			.first<{ name: string }>();
		expect(row?.name).toBe("renamed");
	});
});

// preferredLabelEngine(エチケット解析エンジン)も同じ関門を通ることを確認する。
// スキーマ自体の正しさは config.test.ts、ここでは auth.options への配線を見る。
describe("preferredLabelEngine の書き込みは許可リストで検証される", () => {
	it("許可リストのキーは D1 に保存される", async () => {
		const res = await updateUser({ preferredLabelEngine: "workers-ai" });
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT preferred_label_engine AS e FROM user WHERE id = ?",
		)
			.bind(userId)
			.first<{ e: string | null }>();
		expect(row?.e).toBe("workers-ai");
	});

	it("許可リスト外・巨大な文字列は 400 で弾かれる", () => {
		for (const value of ["claude-opus-5", "a".repeat(300_000)]) {
			const result = parseUpdate({ preferredLabelEngine: value });
			expect(result.status).toBe(400);
			expect(result.parsed).toBeUndefined();
		}
	});

	it("拒否時のメッセージは利用者向けの日本語(プロフィール画面にそのまま出る)", () => {
		expect(parseUpdate({ preferredLabelEngine: "gpt-4" }).message).toBe(
			"対応していない解析エンジンです。",
		);
	});
});

describe("locale の書き込み・Cookie同期は許可リストで検証される (#536)", () => {
	it("許可されたロケールは D1 に保存され、update-user 応答でも Cookie を同期する", async () => {
		const res = await updateUser({ locale: "en" });
		expect(res.status).toBe(200);
		expect(await storedLocale()).toBe("en");
		expect(
			res.headers
				.getSetCookie()
				.some((value) => value.startsWith("wine_locale=en")),
		).toBe(true);
	});

	it("許可リスト外のロケールは 400 で弾かれ、書き込み値に載らない", () => {
		const result = parseUpdate({ locale: "fr" });
		expect(result.status).toBe(400);
		expect(result.parsed).toBeUndefined();
	});

	it("保存済みロケールは新しいサインインの応答 Cookie にも反映される", async () => {
		const res = await signInWithoutCookie();
		expect(res.status).toBe(200);
		expect(
			res.headers
				.getSetCookie()
				.some((value) => value.startsWith("wine_locale=en")),
		).toBe(true);
	});
});
