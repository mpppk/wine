import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertOperator } from "./operator-alert";

// 運用者向け通知の配線を workerd 上で検証する(#395)。見るのは
// 「ログに残るか」「DSN があるときだけ送るか」「送信の失敗で呼び出し元を壊さないか」。
// envelope の中身そのものは sentry-envelope.test.ts が固定している。

const DSN = "https://pub@o1.ingest.sentry.io/42";

function setDsn(value: string | undefined): void {
	if (value === undefined) {
		delete (env as { SENTRY_DSN?: string }).SENTRY_DSN;
		return;
	}
	(env as { SENTRY_DSN?: string }).SENTRY_DSN = value;
}

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
	let requests: { url: string; body: string; headers: Headers }[] = [];

	beforeEach(() => {
		errorLines = [];
		warnLines = [];
		requests = [];
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			errorLines.push(String(line));
		});
		vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
			warnLines.push(String(line));
		});
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					url: String(input),
					body: String(init?.body ?? ""),
					headers: new Headers(init?.headers),
				});
				return new Response("{}", { status: 200 });
			},
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		setDsn(undefined);
	});

	it("DSN 未設定でもログは出す(送信だけしない)", async () => {
		setDsn(undefined);

		alertOperator("credit refund failed after inference error", {
			userId: "u1",
		});

		expect(
			logged(errorLines, "credit refund failed after inference error"),
		).toHaveLength(1);
		expect(requests).toHaveLength(0);
	});

	it("DSN があれば envelope を1本 POST し、ログにも残す", async () => {
		setDsn(DSN);

		alertOperator(
			"credit refund failed after inference error",
			{ userId: "u1", reservedCredits: 30 },
			{ tags: { kind: "credit_refund_failed" } },
		);
		// 送信は待たない設計なので、マイクロタスクを1周させてから観測する。
		await Promise.resolve();

		expect(requests).toHaveLength(1);
		const sent = requests[0];
		expect(sent?.url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
		expect(sent?.headers.get("Content-Type")).toBe(
			"application/x-sentry-envelope",
		);
		expect(sent?.headers.get("X-Sentry-Auth")).toContain("sentry_key=pub");
		const event = JSON.parse(
			(sent?.body ?? "").trimEnd().split("\n")[2] as string,
		);
		expect(event.level).toBe("error");
		expect(event.tags).toMatchObject({ kind: "credit_refund_failed" });
		expect(event.extra).toMatchObject({ userId: "u1", reservedCredits: 30 });

		// ログ側には `operator: true` が立つ(`bun run logs --grep operator` で絞れる)
		const rows = logged(
			errorLines,
			"credit refund failed after inference error",
		);
		expect(rows[0]).toMatchObject({ level: "error", operator: true });
	});

	it("level: warning は warn として記録し、イベントも warning で送る", async () => {
		setDsn(DSN);

		alertOperator(
			"ai inference failed",
			{ feature: "label_analysis" },
			{ level: "warning", tags: { kind: "ai_inference_failed" } },
		);
		await Promise.resolve();

		expect(logged(warnLines, "ai inference failed")).toHaveLength(1);
		expect(logged(errorLines, "ai inference failed")).toHaveLength(0);
		const event = JSON.parse(
			(requests[0]?.body ?? "").trimEnd().split("\n")[2] as string,
		);
		expect(event.level).toBe("warning");
	});

	it("Error は文字列へ畳んでから載せる(JSON化で消えない)", async () => {
		setDsn(DSN);

		alertOperator("credit refund failed after inference error", {
			err: new TypeError("boom"),
		});
		await Promise.resolve();

		const event = JSON.parse(
			(requests[0]?.body ?? "").trimEnd().split("\n")[2] as string,
		);
		expect(event.extra.err).toBe("TypeError: boom");
	});

	// 通知は失敗パスから呼ばれる。ここで throw すると元のエラー処理を壊す。
	it("送信が失敗しても throw せず、警告だけ残す", async () => {
		setDsn(DSN);
		vi.stubGlobal("fetch", async () => {
			throw new Error("network down");
		});

		expect(() =>
			alertOperator("credit refund failed after inference error", {}),
		).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();

		expect(logged(warnLines, "operator alert delivery failed")).toHaveLength(1);
	});

	it("DSN の形が壊れていても throw せず、送信しない", async () => {
		setDsn("not-a-dsn");

		expect(() =>
			alertOperator("credit refund failed after inference error", {}),
		).not.toThrow();
		expect(requests).toHaveLength(0);
	});
});
