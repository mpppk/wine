import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RATE_LIMITERS, withinRateLimit } from "./rate-limit";

// スロットル(#397)を実 workerd 上の Rate Limiting バインディングで検証する。
// バインディングは jsdom には無いので workers プロジェクトに置く。
//
// **上限値そのものは検証しない**。上限は wrangler.jsonc の設定で、テストに数値を
// 書き写しても設定の二重管理になるだけ。ここで固定したいのは「上限に達したら false を
// 返す」「判定できないときは通す」という**振る舞い**の方。
// テスト用の上限は vitest.config.ts で少なく設定してある。

/** キーを毎回変えて、テスト間でカウンタを共有しないようにする。 */
let seq = 0;
function freshKey(): string {
	seq += 1;
	return `rl-test-${seq}`;
}

describe("withinRateLimit", () => {
	it("上限内は true を返し続ける", async () => {
		const key = freshKey();
		expect(await withinRateLimit("write", key)).toBe(true);
		expect(await withinRateLimit("write", key)).toBe(true);
	});

	it("同じキーを叩き続けるといずれ false になる", async () => {
		const key = freshKey();
		let blocked = false;
		// テスト用の上限(3)より十分多く叩く。上限値に依存しないよう回数で決め打ちしない。
		for (let i = 0; i < 20 && !blocked; i++) {
			blocked = !(await withinRateLimit("write", key));
		}
		expect(blocked).toBe(true);
	});

	it("キーが違えば互いのカウンタに影響しない(ユーザ単位で独立)", async () => {
		const victim = freshKey();
		const attacker = freshKey();
		for (let i = 0; i < 20; i++) await withinRateLimit("write", attacker);

		// 攻撃者が使い切っても、別ユーザは通る。
		expect(await withinRateLimit("write", victim)).toBe(true);
	});

	it("用途ごとにカウンタが独立している(1つ使い切っても他は通る)", async () => {
		const key = freshKey();
		for (let i = 0; i < 20; i++) await withinRateLimit("upload", key);

		expect(await withinRateLimit("upload", key)).toBe(false);
		// 画像アップロードを使い切っても、通常の書き込みまで巻き添えで止まらない。
		expect(await withinRateLimit("write", key)).toBe(true);
	});

	// バインディングは wrangler.jsonc の設定なので、設定漏れ・古いプレビューでは
	// 存在しないことがある。そこで throw / 拒否すると「スロットルの設定漏れで
	// アプリ全体が止まる」ことになり、守ろうとしている可用性を自分で壊す。
	it("バインディングが無い環境では素通しする(拒否しない)", async () => {
		const original = env.RATE_LIMIT_WRITE;
		// biome-ignore lint/suspicious/noExplicitAny: 未設定環境の再現のため一時的に外す
		(env as any).RATE_LIMIT_WRITE = undefined;
		try {
			expect(await withinRateLimit("write", freshKey())).toBe(true);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: 後始末
			(env as any).RATE_LIMIT_WRITE = original;
		}
	});

	it("エッジ側の判定が失敗しても素通しする(拒否しない)", async () => {
		const original = env.RATE_LIMIT_WRITE;
		// biome-ignore lint/suspicious/noExplicitAny: 失敗の再現
		(env as any).RATE_LIMIT_WRITE = {
			limit: () => Promise.reject(new Error("edge unavailable")),
		};
		try {
			expect(await withinRateLimit("write", freshKey())).toBe(true);
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: 後始末
			(env as any).RATE_LIMIT_WRITE = original;
		}
	});
});

describe("バインディング名の対応付け", () => {
	// 名前がずれると「設定はあるのに効かない」状態になり、しかも素通し方向に倒れるので
	// 気づきにくい。実 env に対して存在を突き合わせておく。
	it("RATE_LIMITERS の全用途が実際のバインディングに解決できる", () => {
		for (const binding of Object.values(RATE_LIMITERS)) {
			expect(env[binding], `${binding} が env に無い`).toBeDefined();
		}
	});
});
