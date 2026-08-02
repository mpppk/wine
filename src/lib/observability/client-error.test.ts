import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ErrorReporter,
	initClientErrorReporting,
	reportClientError,
} from "./client-error";

// クライアントのエラー収集の関門。ここが担保するのは3つ:
//  - DSN 未設定の環境では収集先を読み込まない(ローカル・CI で外部送信しない)
//  - 収集先の失敗・不在でアプリを壊さない(呼び出し元は既にエラー処理中)
//  - どの状態でもコンソールには必ず出る(DevTools での切り分けを DSN に依存させない)

const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

/** captureException の呼び出しを記録するだけの収集先。 */
function fakeReporter() {
	const calls: Array<{ error: unknown; extra?: Record<string, unknown> }> = [];
	const reporter: ErrorReporter = {
		captureException: (error, hint) => {
			calls.push({ error, extra: hint?.extra });
		},
	};
	return { reporter, calls };
}

afterEach(async () => {
	// 収集先をモジュール状態から外す(テスト間で漏れないように)
	vi.stubEnv("VITE_SENTRY_DSN", "");
	await initClientErrorReporting(async () => null);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("initClientErrorReporting", () => {
	it("DSN が未設定なら収集先を読み込まない", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "");
		const load = vi.fn(async () => fakeReporter().reporter);

		await initClientErrorReporting(load);

		expect(load).not.toHaveBeenCalled();
	});

	it("空白だけの DSN も未設定として扱う", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "   ");
		const load = vi.fn(async () => fakeReporter().reporter);

		await initClientErrorReporting(load);

		expect(load).not.toHaveBeenCalled();
	});

	it("読み込みが失敗してもアプリを壊さない(以後はコンソールのみ)", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", DSN);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(
			initClientErrorReporting(async () => {
				throw new Error("chunk load failed");
			}),
		).resolves.toBeUndefined();

		expect(() => reportClientError(new Error("boom"))).not.toThrow();
		expect(consoleError).toHaveBeenCalled();
	});
});

describe("reportClientError", () => {
	it("収集先へエラーと文脈を渡す", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", DSN);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { reporter, calls } = fakeReporter();
		await initClientErrorReporting(async () => reporter);

		const error = new TypeError("Failed to fetch");
		reportClientError(error, { kind: "image_upload_network", bytes: 1234 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.error).toBe(error);
		expect(calls[0]?.extra).toEqual({
			kind: "image_upload_network",
			bytes: 1234,
		});
	});

	it("収集先が無くてもコンソールには出る", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", "");
		await initClientErrorReporting(async () => null);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		reportClientError(new Error("boom"), { kind: "route" });

		expect(consoleError).toHaveBeenCalledWith(
			"client error",
			{ kind: "route" },
			expect.any(Error),
		);
	});

	it("収集先が throw しても呼び出し元へ伝播しない", async () => {
		vi.stubEnv("VITE_SENTRY_DSN", DSN);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await initClientErrorReporting(async () => ({
			captureException: () => {
				throw new Error("transport exploded");
			},
		}));

		expect(() => reportClientError(new Error("boom"))).not.toThrow();
	});
});
