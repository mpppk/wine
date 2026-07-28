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

/** clientIp を渡すと CF-Connecting-IP 付きのリクエストになる(未指定なら従来どおりヘッダ無し) */
function signInProbe(clientIp?: string): Request {
	return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
		method: "GET",
		headers: clientIp
			? { origin: BASE_URL, "cf-connecting-ip": clientIp }
			: { origin: BASE_URL },
	});
}

/** rate_limit に載っているキーのうち sign-in のものを取り出す */
async function signInRateLimitKeys(): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT key FROM rate_limit WHERE key LIKE '%|/sign-in/email'",
	).all<{ key: string }>();
	return rows.results.map((r) => r.key);
}

/** 指定キーの現在のカウンタ値(未作成なら 0) */
async function rateLimitCount(key: string): Promise<number> {
	const row = await env.DB.prepare("SELECT count FROM rate_limit WHERE key = ?")
		.bind(key)
		.first<{ count: number }>();
	return row?.count ?? 0;
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

// クライアントIPが解決できないと、カウンタのキーが no-trusted-ip|<path> という
// 「パスごとの単一バケット」に潰れ、1クライアントが sign-in を10秒に3回叩くだけで
// その経路が全ユーザに対して閉じる(Issue #197)。better-auth の既定ヘッダは
// X-Forwarded-For だが Cloudflare 経由ではカンマ連結になりうるため信用されない。
// advanced.ipAddress.ipAddressHeaders に CF-Connecting-IP を指定して解決させる。
//
// テストごとに別のIPを使う。rate_limit は key に unique 制約があり行が残るため、
// 同じIPを使い回すと先行テストで消費済みのバケットを引いてしまう。
describe("auth rate limiting keys by client IP (#197)", () => {
	it("uses the CF-Connecting-IP address as the rate-limit key", async () => {
		// IPを解決できないリクエストが集約される共有バケット。この workers 環境は
		// NODE_ENV が test/development のいずれでもないため、better-auth のローカル
		// フォールバック(127.0.0.1)が効かず本番と同じ経路になる。上の #31 のテストが
		// IPヘッダ無しで叩いているので、この時点で既に行が存在する。
		const sharedKey = "no-trusted-ip|/sign-in/email";
		const sharedBefore = await rateLimitCount(sharedKey);

		await auth.handler(signInProbe("203.0.113.7"));

		// CF-Connecting-IP がキーになる。設定が無ければこのキーは作られない。
		expect(await signInRateLimitKeys()).toContain("203.0.113.7|/sign-in/email");
		// かつ、共有バケットは消費していない(IP単位に分かれている直接の証拠)。
		expect(await rateLimitCount(sharedKey)).toBe(sharedBefore);
	});

	it("does not let one client's requests exhaust another client's bucket", async () => {
		// IP-A で既定スペシャルルール(10秒3回)を超過すると 429 になる
		const noisy: number[] = [];
		for (let i = 0; i < 4; i++) {
			const res = await auth.handler(signInProbe("203.0.113.8"));
			noisy.push(res.status);
		}
		expect(noisy.at(-1)).toBe(429);

		// 別IPは巻き添えを食わない。共有バケットに潰れていると、ここが 429 になる。
		const other = await auth.handler(signInProbe("203.0.113.9"));
		expect(other.status).not.toBe(429);
	});
});
