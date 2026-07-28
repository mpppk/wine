import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";
import { isAuthorizedForPrivateImage } from "#/lib/images/authorize";
import {
	EXPIRES_PARAM,
	expiresAtFrom,
	SIGNATURE_PARAM,
	signImageKey,
} from "#/lib/images/signed-url";
import {
	getImageSigningKey,
	resetImageSigningKeyCache,
} from "#/lib/images/signing-key";

// 非公開のマイセラー写真(wines/)の認可を、実D1(better-auth のセッション)と
// 実R2(署名鍵の永続化)の上で検証する(Issue #149)。
//
// #149 以前は /api/images/$ に認可が一切無く、URLを知る誰でも他人の写真を恒久的に
// 読めた。ここが緑であることが「無認証では読めない」ことの回帰固定になる。

const BASE_URL = "http://localhost:3000";

/** 署名もCookieも持たない、URLだけを知っている第三者のリクエスト。 */
function anonymousRequest(path: string): { request: Request; url: URL } {
	const request = new Request(`${BASE_URL}${path}`);
	return { request, url: new URL(request.url) };
}

function requestWithCookie(
	path: string,
	cookie: string,
): { request: Request; url: URL } {
	const request = new Request(`${BASE_URL}${path}`, { headers: { cookie } });
	return { request, url: new URL(request.url) };
}

/** サインアップして、そのユーザのIDとセッションCookieを得る。 */
async function signUp(email: string): Promise<{ id: string; cookie: string }> {
	const res = await auth.handler(
		new Request(`${BASE_URL}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE_URL },
			body: JSON.stringify({
				email,
				password: "test-password-1234",
				name: email,
			}),
		}),
	);
	if (!res.ok) throw new Error(`sign-up failed: ${res.status}`);
	const body = (await res.json()) as { user?: { id?: string } };
	const setCookie = res.headers.get("set-cookie");
	const id = body.user?.id;
	if (!id || !setCookie) throw new Error("sign-up returned no user/cookie");
	// Set-Cookie の属性(Path/HttpOnly 等)を落として name=value だけにする
	return { id, cookie: setCookie.split(";")[0] ?? "" };
}

let owner: { id: string; cookie: string };
let other: { id: string; cookie: string };

beforeAll(async () => {
	owner = await signUp("owner@example.test");
	other = await signUp("other@example.test");
});

function keyOf(userId: string): string {
	return `wines/${userId}/entry-1/photo-1.jpg`;
}

describe("isAuthorizedForPrivateImage", () => {
	it("署名もセッションも無いリクエストは通さない", async () => {
		const path = `/api/images/${keyOf(owner.id)}`;
		const { request, url } = anonymousRequest(path);
		expect(
			await isAuthorizedForPrivateImage(request, url, keyOf(owner.id)),
		).toBe(false);
	});

	it("本人のセッションなら通す", async () => {
		const k = keyOf(owner.id);
		const { request, url } = requestWithCookie(
			`/api/images/${k}`,
			owner.cookie,
		);
		expect(await isAuthorizedForPrivateImage(request, url, k)).toBe(true);
	});

	it("別ユーザのセッションでは他人の写真を通さない", async () => {
		const k = keyOf(owner.id);
		const { request, url } = requestWithCookie(
			`/api/images/${k}`,
			other.cookie,
		);
		expect(await isAuthorizedForPrivateImage(request, url, k)).toBe(false);
	});

	it("有効な署名付きURLなら Cookie 無しでも通す(MCP/埋め込みビュー経路)", async () => {
		const k = keyOf(owner.id);
		const exp = expiresAtFrom(Date.now());
		const sig = await signImageKey(await getImageSigningKey(), k, exp);
		const { request, url } = anonymousRequest(
			`/api/images/${k}?${EXPIRES_PARAM}=${exp}&${SIGNATURE_PARAM}=${sig}`,
		);
		expect(await isAuthorizedForPrivateImage(request, url, k)).toBe(true);
	});

	it("期限切れの署名は通さない", async () => {
		const k = keyOf(owner.id);
		const exp = Math.floor(Date.now() / 1000) - 1;
		const sig = await signImageKey(await getImageSigningKey(), k, exp);
		const { request, url } = anonymousRequest(
			`/api/images/${k}?${EXPIRES_PARAM}=${exp}&${SIGNATURE_PARAM}=${sig}`,
		);
		expect(await isAuthorizedForPrivateImage(request, url, k)).toBe(false);
	});

	it("他人の写真のキーへ自分の署名を付け替えても通さない", async () => {
		const mine = keyOf(owner.id);
		const theirs = keyOf(other.id);
		const exp = expiresAtFrom(Date.now());
		const sig = await signImageKey(await getImageSigningKey(), mine, exp);
		const { request, url } = anonymousRequest(
			`/api/images/${theirs}?${EXPIRES_PARAM}=${exp}&${SIGNATURE_PARAM}=${sig}`,
		);
		expect(await isAuthorizedForPrivateImage(request, url, theirs)).toBe(false);
	});
});

describe("getImageSigningKey", () => {
	it("鍵をR2に永続化し、isolate キャッシュを捨てても同じ鍵を返す", async () => {
		// 鍵が isolate ごとの乱数だと、署名した isolate 以外で検証が落ちて
		// 写真が散発的に表示されなくなる。R2 に置いて全 isolate で共有する。
		const k1 = await getImageSigningKey();
		const exp = expiresAtFrom(Date.now());
		const sig = await signImageKey(k1, "wines/u/e/p.jpg", exp);

		resetImageSigningKeyCache();
		const k2 = await getImageSigningKey();
		expect(await signImageKey(k2, "wines/u/e/p.jpg", exp)).toBe(sig);
	});

	it("鍵オブジェクトは配信対象のプレフィックス(avatars/ wines/)の外に置く", async () => {
		// 鍵が avatars/ や wines/ の下にあると、/api/images/$ の
		// isAllowedImageKey を通って鍵そのものが配信されてしまう。
		await getImageSigningKey();
		const listed = await env.AVATARS.list();
		expect(listed.objects.length).toBeGreaterThan(0);
		for (const o of listed.objects) {
			expect(o.key).not.toMatch(/^(avatars|wines)\//);
		}
	});
});
