import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 起動時ガードの**配線**を検証する(#389)。判定ロジックそのものは auth-secret.test.ts が
// 見ているが、「auth.ts のモジュール初期化で実際に発火するか」はここでしか確認できない。
//
// PRごとのプレビューURLは Workers Logs から見えない(docs/deployment.md)ため、
// 「デプロイして logError が出ることを目で見る」検証は取れない。実ランタイム(workerd)上で
// モジュールを読み込んで確かめるこのテストがその代わりになる。
//
// workers テストの miniflare バインディング(vitest.config.ts)には BETTER_AUTH_SECRET を
// 与えていないので、この環境は「未設定」のケースそのもの。

const logError = vi.fn();
vi.mock("#/lib/logger", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/logger")>()),
	logError: (...args: unknown[]) => logError(...args),
}));

describe("BETTER_AUTH_SECRET 起動時ガードの配線 (#389)", () => {
	beforeEach(() => {
		logError.mockReset();
		vi.resetModules();
	});

	it("テスト環境では BETTER_AUTH_SECRET が未設定である(前提の確認)", () => {
		// この前提が崩れると以下のテストが何も検証しなくなる。
		expect(env.BETTER_AUTH_SECRET).toBeFalsy();
	});

	it("auth.ts の読み込みで未設定が logError として報告される", async () => {
		await import("#/lib/auth");

		const reported = logError.mock.calls.filter((call) =>
			String(call[0]).includes("BETTER_AUTH_SECRET"),
		);
		expect(reported).toHaveLength(1);

		const [message, fields] = reported[0] as [string, { problem?: string }];
		expect(fields.problem).toBe("missing");
		// 見つけた人がそのまま実行できるよう、対処コマンドまでログ1行に含める。
		expect(message).toContain("wrangler");
	}, 30_000);

	it("未設定でも auth 自体は起動する(起動拒否にしていない)", async () => {
		const { auth } = await import("#/lib/auth");
		expect(auth.api).toBeDefined();
	}, 30_000);
});
