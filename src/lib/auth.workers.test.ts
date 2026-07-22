import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { auth } from "#/lib/auth";

// better-auth のレートリミットを D1 永続ストレージ(rate_limit テーブル / drizzle/0017)で
// 有効化したこと(Issue #31)を実D1(miniflare)上で検証する。既定のインメモリ storage は
// Cloudflare Workers の isolate 分離下では全 isolate でカウンタを共有できず効かないため、
// storage:"database" に切り替えた。sign-in パスの既定スペシャルルール(10秒3回)が発火し、
// カウンタが D1 に永続化されることを確かめる。
//
// リクエストは GET を使う。sign-in の資格情報検証ロジックを走らせずにレートリミッタだけを
// 駆動でき(未マッチのメソッドは 404)、better-auth が資格情報エラー時に投げる
// unhandled rejection でテストランが汚れるのを避けられる。レートリミットはメソッドに依らず
// パスで発火するため、GET でも同じスペシャルルールが適用される。

const BASE_URL = "http://localhost:3000";

function signInProbe(): Request {
	return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
		method: "GET",
		headers: { origin: BASE_URL },
	});
}

describe("auth rate limiting (D1 permanent storage, #31)", () => {
	it("returns 429 once the sign-in special rule (10s/3) is exceeded", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await auth.handler(signInProbe());
			statuses.push(res.status);
		}
		// 4回目以降(既定スペシャルルール sign-in: 10秒3回を超過)は 429 になる。
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
		expect(statuses.at(-1)).toBe(429);
	});

	it("persists the rate-limit counter to the D1 rate_limit table", async () => {
		await auth.handler(signInProbe());
		// インメモリ storage ではこの行は作られない。D1 に載る = isolate 横断で効く。
		const row = await env.DB.prepare(
			"SELECT count(*) AS c FROM rate_limit",
		).first<{ c: number }>();
		expect(row?.c ?? 0).toBeGreaterThan(0);
	});
});
