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

/**
 * ip を渡すと `CF-Connecting-IP` を付けて送る(Cloudflare 実機と同じ形)。
 * 省略時はIPヘッダ無し = better-auth がテスト環境で 127.0.0.1 にフォールバックする。
 */
function signInProbe(ip?: string): Request {
	return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
		method: "GET",
		headers: {
			origin: BASE_URL,
			...(ip ? { "cf-connecting-ip": ip } : {}),
		},
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

// レートリミットのバケットがクライアントIPごとに分かれることを検証する(Issue #197)。
// `advanced.ipAddress.ipAddressHeaders` 未設定だと better-auth は既定の x-forwarded-for
// しか見ずIPを解決できず、全リクエストが「パスごとの単一共有バケット」に集約される。
// その状態では 1クライアントの sign-in 連打で無関係な全ユーザが 429 になる。
// このテストは設定が外れた場合や、better-auth 更新でIP解決の仕様が変わった場合に落ちる
// (CIが緑でも実機で壊れる類の変更を検出するための回帰テスト)。
describe("rate limit is keyed per client IP (#197)", () => {
	it("does not spill one client's 429 over to a different IP", async () => {
		// ドキュメント用アドレス(TEST-NET-3)。他テストのバケットと衝突しない値を使う。
		const noisyClient = "203.0.113.10";
		const innocentClient = "203.0.113.11";

		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			statuses.push((await auth.handler(signInProbe(noisyClient))).status);
		}
		// 連打した側は既定スペシャルルール(10秒3回)を超えて 429 になる
		expect(statuses.at(-1)).toBe(429);

		// 別IPは影響を受けない。IPが解決できていないと同じバケットを共有して 429 になる。
		const other = await auth.handler(signInProbe(innocentClient));
		expect(other.status).not.toBe(429);
	});
});
