import { env } from "cloudflare:workers";
import { parseUserInput } from "better-auth/db";
import { beforeAll, describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";
import { signUpTestUser, updateUserRequest } from "#/lib/auth-test-helpers";
import { LOCALE_COOKIE_NAME } from "#/lib/locale";
import * as userService from "#/lib/services/user-service";
import { getLocale } from "#/paraglide/runtime.js";
import { paraglideMiddleware } from "#/paraglide/server.js";

// ロケール解決の骨組み(i18n Phase 1 #536)。Cookie 読み取りと
// AsyncLocalStorage は workerd 上でしか正しく検証できないため
// workers プロジェクトに置く。

/** 指定 Cookie でミドルウェアを通し、解決中の getLocale() を返す */
async function resolveLocale(cookieHeader?: string): Promise<string> {
	const headers = new Headers();
	if (cookieHeader !== undefined) headers.set("cookie", cookieHeader);
	const request = new Request("http://localhost:3000/", { headers });
	const response = await paraglideMiddleware(
		request,
		() => new Response(getLocale()),
	);
	return response.text();
}

describe("paraglideMiddleware のロケール解決", () => {
	it("wine_locale=en なら en", async () => {
		await expect(resolveLocale(`${LOCALE_COOKIE_NAME}=en`)).resolves.toBe("en");
	});

	it("wine_locale=ja なら ja", async () => {
		await expect(resolveLocale(`${LOCALE_COOKIE_NAME}=ja`)).resolves.toBe("ja");
	});

	it("Cookie が無ければ既定 ja(Accept-Language を見ない)", async () => {
		const headers = new Headers({ "accept-language": "en-US,en;q=0.9" });
		const request = new Request("http://localhost:3000/", { headers });
		const response = await paraglideMiddleware(
			request,
			() => new Response(getLocale()),
		);
		await expect(response.text()).resolves.toBe("ja");
	});

	it("未知の値は既定 ja へ落ちる", async () => {
		await expect(resolveLocale(`${LOCALE_COOKIE_NAME}=fr`)).resolves.toBe("ja");
	});

	it("非同期の処理を挟んでも解決値が保たれる(server function 経路の前提)", async () => {
		// server function も fetch ハンドラ全体の包みの中で動く(worker.ts)。
		// Phase 4 でサーバ側が設問文を組むとき、await を挟んだ先でも同じ
		// ロケールが見えることが必要条件のため、ここで固定する。
		const request = new Request("http://localhost:3000/", {
			headers: { cookie: `${LOCALE_COOKIE_NAME}=en` },
		});
		const seen = await paraglideMiddleware(request, async () => {
			await new Promise((r) => setTimeout(r, 10));
			const first = getLocale();
			await new Promise((r) => setTimeout(r, 10));
			return new Response(JSON.stringify([first, getLocale()]));
		}).then((r) => r.json());
		expect(seen).toEqual(["en", "en"]);
	});
});

// user.locale 列の書き込みは better-auth のハンドラ直結のため、
// additionalFields validator の配線をここで押さえる(#256 と同じ構図)。
describe("user.locale の書き込みは許可リストで検証される", () => {
	const EMAIL = "user-locale@example.com";
	const PASSWORD = "test-password-536";
	let cookie = "";
	let userId = "";

	beforeAll(async () => {
		({ cookie, userId } = await signUpTestUser({
			name: "user locale",
			email: EMAIL,
			password: PASSWORD,
		}));
	});

	function parseUpdate(body: Record<string, unknown>) {
		try {
			return { parsed: parseUserInput(auth.options, body, "update") };
		} catch (e) {
			const err = e as { statusCode?: number; body?: { message?: string } };
			if (typeof err.statusCode !== "number") throw e;
			return { status: err.statusCode, message: err.body?.message };
		}
	}

	it("ja/en は D1 に保存される", async () => {
		for (const locale of ["en", "ja"]) {
			const res = await updateUserRequest(cookie, { locale });
			expect(res.status).toBe(200);
			const row = await env.DB.prepare("SELECT locale FROM user WHERE id = ?")
				.bind(userId)
				.first<{ locale: string | null }>();
			expect(row?.locale).toBe(locale);
		}
	});

	it("許可リスト外の文字列は 400 で弾かれる", () => {
		for (const value of ["fr", "a".repeat(300_000)]) {
			const result = parseUpdate({ locale: value });
			expect(result.status).toBe(400);
			expect(result.parsed).toBeUndefined();
		}
	});

	it("拒否時のメッセージは利用者向けの日本語", () => {
		expect(parseUpdate({ locale: "fr" }).message).toBe(
			"対応していない言語です。",
		);
	});

	it("getUserLocale は保存値を返し、未設定なら null", async () => {
		await updateUserRequest(cookie, { locale: "en" });
		await expect(userService.getUserLocale(userId)).resolves.toBe("en");
		await env.DB.prepare("UPDATE user SET locale = NULL WHERE id = ?")
			.bind(userId)
			.run();
		await expect(userService.getUserLocale(userId)).resolves.toBeNull();
	});
});
