import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { auth } from "#/lib/auth";

/** workers テストで auth.handler を叩くときの起点。BETTER_AUTH_URL と合わせる。 */
export const AUTH_TEST_BASE_URL = "http://localhost:3000";

/** auth エンドポイントへ JSON を POST する(サインアップ画面・プロフィール画面と同じ経路) */
function postAuth(
	path: string,
	body: Record<string, unknown>,
	cookie?: string,
): Promise<Response> {
	return auth.handler(
		new Request(`${AUTH_TEST_BASE_URL}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: AUTH_TEST_BASE_URL,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}

/** sign-up/email を叩く(サインアップ画面の authClient.signUp.email と同じ経路) */
export function signUpEmailRequest(
	body: Record<string, unknown>,
): Promise<Response> {
	return postAuth("/api/auth/sign-up/email", body);
}

/** update-user を叩く(プロフィール画面の authClient.updateUser と同じ経路) */
export function updateUserRequest(
	cookie: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return postAuth("/api/auth/update-user", body, cookie);
}

/**
 * sign-up して以降のリクエストで使うセッションクッキーと userId を返す。
 * Set-Cookie は複数行になりうるため、name=value 部分だけを連結する。
 */
export async function signUpTestUser(args: {
	name: string;
	email: string;
	password: string;
}): Promise<{ cookie: string; userId: string }> {
	const res = await signUpEmailRequest(args);
	expect(res.status).toBe(200);
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	expect(cookie).not.toBe("");

	const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
		.bind(args.email)
		.first<{ id: string }>();
	const userId = row?.id ?? "";
	expect(userId).not.toBe("");
	return { cookie, userId };
}
