import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
	SIGNING_KEY_OBJECT,
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

// 初回生成の競合 (#642)。2つの isolate が同時に初期化すると、旧実装の
// 無条件 PUT では「A が PUT(keyA)→GET で keyA を掴む→B が PUT(keyB)で
// 上書き→B は keyB を掴む」と鍵が割れ、A の署名が B で検証できなくなる。
// 条件付き put(無ければ作る)+負けた側の読み直しで1つの鍵に収束させる。
describe("署名鍵の初回生成の競合 (#642)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetImageSigningKeyCache();
	});

	it("2つの isolate が同時に初期化しても1つの鍵に収束する", async () => {
		// 新しい環境の初回アクセスを再現: R2 に鍵が無い状態から始める。
		// 実R2に残っていると条件付き put が両方とも負け扱いになり、
		// 競合そのものを再現できない。
		await env.AVATARS.delete(SIGNING_KEY_OBJECT);
		resetImageSigningKeyCache();

		const realGet = env.AVATARS.get.bind(env.AVATARS);
		const realPut = env.AVATARS.put.bind(env.AVATARS);

		// 両者の初回 GET は「鍵なし」を観測する(同時初期化の再現)。
		// 3回目以降の GET(負けた側の読み直し)は実R2へ通す。
		let getCalls = 0;
		vi.spyOn(env.AVATARS, "get").mockImplementation((async (key: string) => {
			if (key !== SIGNING_KEY_OBJECT) return realGet(key);
			getCalls += 1;
			if (getCalls <= 2) return null;
			return realGet(key);
		}) as typeof env.AVATARS.get);

		// PUT は呼び出し順に溜め、テストが順番に実R2へ流して決定的な
		// interleaving を作る。「A の PUT→A の完了→B の PUT→B の完了」は、
		// A が keyA を掴んだ後に B が keyB で上書きする旧バグの手順そのもの。
		// コードが put に渡した options ごと再生するので、無条件 PUT のままなら
		// B が上書きして鍵が割れ(このテストが落ち)、条件付きなら B が負けて
		// 読み直す(このテストが通る)。
		type DeferredPut = {
			value: Uint8Array;
			options: R2PutOptions | undefined;
			resolve: (result: R2Object | null) => void;
		};
		const putCalls: DeferredPut[] = [];
		vi.spyOn(env.AVATARS, "put").mockImplementation(((
			key: string,
			value: Uint8Array,
			options?: R2PutOptions,
		) => {
			if (key !== SIGNING_KEY_OBJECT) return realPut(key, value);
			return new Promise<R2Object | null>((resolve) => {
				putCalls.push({ value, options, resolve });
			});
		}) as unknown as typeof env.AVATARS.put);

		// isolate 境界を跨ぐ2つの初期化を、共有キャッシュを外して再現する。
		const pendingA = getImageSigningKey();
		resetImageSigningKeyCache();
		const pendingB = getImageSigningKey();

		// 両者の PUT が出揃うまで待つ(初回 GET はどちらも null を見ている)。
		await vi.waitFor(() => expect(putCalls.length).toBe(2));
		const first = putCalls[0];
		const second = putCalls[1];
		if (!first || !second) throw new Error("unreachable");
		// 両者が別々の乱数を掴んでいること(同じ値なら競合の再現にならない)。
		expect(first.value).not.toEqual(second.value);

		// A を先に通して完了させる。
		first.resolve(
			await realPut(SIGNING_KEY_OBJECT, first.value, first.options),
		);
		const keyA = await pendingA;
		// B を後に通す。R2 は既に A の鍵。旧実装なら上書きで鍵が割れる。
		second.resolve(
			await realPut(SIGNING_KEY_OBJECT, second.value, second.options),
		);
		const keyB = await pendingB;

		// 両者が同じ鍵を掴んだことを署名で確認する。
		const exp = expiresAtFrom(Date.now());
		const path = "wines/u/e/p.jpg";
		expect(await signImageKey(keyB, path, exp)).toBe(
			await signImageKey(keyA, path, exp),
		);
	});
});

// 鍵のロード失敗は、R2 障害時に非公開写真だけが 404 になる事象の唯一の手がかり。
// 他の全経路と同じ `err` フィールドで出さないと、Workers Logs の横断検索から漏れる(#271)。
describe("署名鍵のロード失敗のログ (#271)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetImageSigningKeyCache();
	});

	it("err フィールドと対象キーを構造化ログに残し、fail-closed で通さない", async () => {
		resetImageSigningKeyCache();
		vi.spyOn(env.AVATARS, "get").mockRejectedValue(new Error("R2 unavailable"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const r2Key = keyOf(owner.id);
		// 署名付きURLの形にして、鍵ロードの経路へ入らせる(値は検証まで到達しない)
		const path = `/api/images/${r2Key}?${EXPIRES_PARAM}=${expiresAtFrom(Date.now())}&${SIGNATURE_PARAM}=dummy`;
		const { request, url } = anonymousRequest(path);

		// 鍵が読めないので署名経路は諦め、セッションも無いので通さない(fail-closed)
		expect(await isAuthorizedForPrivateImage(request, url, r2Key)).toBe(false);

		const line = errors.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("failed to load image signing key"));
		expect(line).toBeDefined();
		const parsed = JSON.parse(line as string);
		expect(parsed.level).toBe("error");
		// `error` ではなく `err`(logger が文字列化する)
		expect(parsed.err).toContain("R2 unavailable");
		expect(parsed.error).toBeUndefined();
		expect(parsed.r2Key).toBe(r2Key);
	});
});
