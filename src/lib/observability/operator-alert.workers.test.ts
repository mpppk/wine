import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 運用者向け通知の配線を workerd 上で検証する(#395 / #649)。見るのは
// 「ログに残るか」「SDK に level/tags/extra 付きで渡るか」
// 「送信の失敗で呼び出し元を壊さないか」。送信の実体(DSN・environment・
// PII 抑止・再試行)は `withSentry` の初期化(`src/worker.ts`)に委ねるため、
// ここでは SDK の呼び口だけを固定する。

const { captureMessage, captureException } = vi.hoisted(() => ({
	captureMessage: vi.fn(),
	captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
	captureMessage: (...args: unknown[]) =>
		(captureMessage as (...a: unknown[]) => unknown)(...args),
	captureException: (...args: unknown[]) =>
		(captureException as (...a: unknown[]) => unknown)(...args),
}));

const { alertOperator } = await import("./operator-alert");

/** 構造化ログ(1行JSON)を msg で拾う。 */
function logged(lines: string[], msg: string): Record<string, unknown>[] {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((o): o is Record<string, unknown> => o?.msg === msg);
}

describe("alertOperator", () => {
	let errorLines: string[] = [];
	let warnLines: string[] = [];

	beforeEach(() => {
		errorLines = [];
		warnLines = [];
		captureMessage.mockClear();
		captureException.mockClear();
		// 一度だけ throw させる指定が残らないよう、既定の実装に戻す。
		captureMessage.mockImplementation(() => "msg-id");
		captureException.mockImplementation(() => "exc-id");
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

	it("Error が無ければ captureMessage で送り、ログにも残す", () => {
		alertOperator(
			"credit refund failed after inference error",
			{ userId: "u1", reservedCredits: 30 },
			{ tags: { kind: "credit_refund_failed" } },
		);

		expect(captureMessage).toHaveBeenCalledTimes(1);
		expect(captureException).not.toHaveBeenCalled();
		const [msg, context] = captureMessage.mock.calls[0] as [
			string,
			{
				level: string;
				tags: Record<string, string>;
				extra: Record<string, unknown>;
			},
		];
		expect(msg).toBe("credit refund failed after inference error");
		expect(context.level).toBe("error");
		expect(context.tags).toMatchObject({
			kind: "credit_refund_failed",
			runtime: "workers",
		});
		// 部分集合だけが送られる(呼び出し側が選んだ fields のみ。余計な付帯情報は載せない)
		expect(context.extra).toEqual({ userId: "u1", reservedCredits: 30 });

		// ログ側には `operator: true` が立つ(`bun run logs --grep operator` で絞れる)
		const rows = logged(
			errorLines,
			"credit refund failed after inference error",
		);
		expect(rows[0]).toMatchObject({ level: "error", operator: true });
	});

	it("level: warning は warn として記録し、warning で送る", () => {
		alertOperator(
			"ai inference failed",
			{ feature: "label_analysis" },
			{ level: "warning", tags: { kind: "ai_inference_failed" } },
		);

		expect(logged(warnLines, "ai inference failed")).toHaveLength(1);
		expect(logged(errorLines, "ai inference failed")).toHaveLength(0);
		const [, context] = captureMessage.mock.calls[0] as [
			string,
			{ level: string },
		];
		expect(context.level).toBe("warning");
	});

	it("fields.err が Error なら captureException で送り、表題は運用メッセージのまま", () => {
		const cause = new TypeError("boom");
		alertOperator("credit refund failed after inference error", {
			userId: "u1",
			err: cause,
		});

		expect(captureMessage).not.toHaveBeenCalled();
		expect(captureException).toHaveBeenCalledTimes(1);
		const [exc, context] = captureException.mock.calls[0] as [
			Error,
			{
				level: string;
				tags: Record<string, string>;
				extra: Record<string, unknown>;
			},
		];
		// 表題は運用メッセージ(グルーピングのキー)。原因のスタックは cause に残る。
		expect(exc.message).toBe("credit refund failed after inference error");
		expect(exc.cause).toBe(cause);
		expect(context.level).toBe("error");
		expect(context.tags).toMatchObject({ runtime: "workers" });
		// Error は文字列へ畳んでから載せる(JSON化で消えない。検索用)
		expect(context.extra).toMatchObject({
			userId: "u1",
			err: "TypeError: boom",
		});
	});

	it("err 以外のキーにある Error も文字列へ畳む", () => {
		alertOperator("extension code compensation failed", {
			userId: "u1",
			originalErr: new TypeError("boom"),
		});

		expect(captureMessage).toHaveBeenCalledTimes(1);
		const [, context] = captureMessage.mock.calls[0] as [
			string,
			{ extra: Record<string, unknown> },
		];
		expect(context.extra).toMatchObject({
			userId: "u1",
			originalErr: "TypeError: boom",
		});
	});

	// 通知は失敗パスから呼ばれる。ここで throw すると元のエラー処理を壊す。
	it("SDK が失敗しても throw せず、警告だけ残す", () => {
		captureMessage.mockImplementationOnce(() => {
			throw new Error("sentry down");
		});

		expect(() =>
			alertOperator("credit refund failed after inference error", {}),
		).not.toThrow();

		expect(logged(warnLines, "operator alert delivery failed")).toHaveLength(1);
	});

	it("captureException の失敗でも throw しない", () => {
		captureException.mockImplementationOnce(() => {
			throw new Error("sentry down");
		});

		expect(() =>
			alertOperator("credit refund failed after inference error", {
				err: new TypeError("boom"),
			}),
		).not.toThrow();

		expect(logged(warnLines, "operator alert delivery failed")).toHaveLength(1);
	});
});
