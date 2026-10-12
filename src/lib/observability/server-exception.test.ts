import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 握りつぶした想定外例外の Sentry 送信を固定する。見るのは
// 「ログ行が従来の logError と同じか」「元の例外をそのまま送るか(包むと全経路が
// 1 Issue に潰れる)」「userId 等を Sentry に送らないか」「送信失敗で throw しないか」。

const { captureException } = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
	captureException: (...args: unknown[]) =>
		(captureException as (...a: unknown[]) => unknown)(...args),
}));

const { reportServerException } = await import("./server-exception");

function parsed(lines: string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("reportServerException", () => {
	let errorLines: string[] = [];
	let warnLines: string[] = [];

	beforeEach(() => {
		errorLines = [];
		warnLines = [];
		captureException.mockReset();
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			errorLines.push(String(line));
		});
		vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
			warnLines.push(String(line));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("従来どおりの構造化ログを1行出す", () => {
		const boom = new TypeError("x is undefined");
		reportServerException(
			"server fn failed",
			{ userId: "u1", path: "/_serverFn/abc", err: boom },
			{ source: "server_fn", tags: { path: "/_serverFn/abc" } },
		);

		expect(parsed(errorLines)).toEqual([
			{
				level: "error",
				msg: "server fn failed",
				userId: "u1",
				path: "/_serverFn/abc",
				err: "TypeError: x is undefined",
			},
		]);
	});

	it("元の例外をそのまま送り、source とタグを付ける", () => {
		const boom = new Error("D1_ERROR: no such column");
		reportServerException(
			"mcp tool failed",
			{ tool: "list_aops", userId: "u1", err: boom },
			{ source: "mcp_tool", tags: { tool: "list_aops" } },
		);

		expect(captureException).toHaveBeenCalledTimes(1);
		const [sent, context] = captureException.mock.calls[0] as [
			unknown,
			{
				level: string;
				tags: Record<string, string>;
				extra: Record<string, unknown>;
			},
		];
		// 包まない: スタックが元の例外のまま Sentry のグルーピングに効く
		expect(sent).toBe(boom);
		expect(context.level).toBe("error");
		expect(context.tags).toEqual({
			runtime: "workers",
			source: "mcp_tool",
			tool: "list_aops",
		});
		expect(context.extra).toEqual({ msg: "mcp tool failed" });
	});

	it("userId などのフィールドは Sentry に送らない", () => {
		reportServerException(
			"wine photo sync failed",
			{ userId: "u-secret", err: new Error("r2 down") },
			{ source: "api", tags: { route: "/api/wine-photos" } },
		);

		expect(JSON.stringify(captureException.mock.calls)).not.toContain(
			"u-secret",
		);
	});

	it("undefined のタグは落とす", () => {
		reportServerException(
			"server fn failed",
			{ err: new Error("boom") },
			{ source: "server_fn", tags: { path: undefined } },
		);

		const [, context] = captureException.mock.calls[0] as [
			unknown,
			{ tags: Record<string, string> },
		];
		expect(context.tags).toEqual({ runtime: "workers", source: "server_fn" });
	});

	it("送信が throw しても呼び出し元へ伝播させず warn に残す", () => {
		captureException.mockImplementation(() => {
			throw new Error("sdk exploded");
		});

		expect(() =>
			reportServerException(
				"label job consumer failed",
				{ jobId: "j1", err: new Error("boom") },
				{ source: "queue" },
			),
		).not.toThrow();
		expect(parsed(errorLines)).toHaveLength(1);
		expect(parsed(warnLines)).toEqual([
			{
				level: "warn",
				msg: "server exception capture failed",
				err: "sdk exploded",
			},
		]);
	});
});
