import { describe, expect, it } from "vitest";
import {
	buildSentryEnvelope,
	parseSentryDsn,
	resolveServerEnvironment,
} from "./sentry-envelope";

// SDK を使わずに送るので、envelope の形が壊れても実行時に気付けるのは
// 「Sentry に何も届かない」という**沈黙**だけになる。形を固定しておく(#395)。

describe("parseSentryDsn", () => {
	it("公開キー・プロジェクトID・envelope の送信先を取り出す", () => {
		const parsed = parseSentryDsn("https://abc123@o42.ingest.sentry.io/98765");
		expect(parsed).toEqual({
			endpoint: "https://o42.ingest.sentry.io/api/98765/envelope/",
			publicKey: "abc123",
			projectId: "98765",
		});
	});

	it("パス接頭辞のあるセルフホストDSNでも組み立てられる", () => {
		const parsed = parseSentryDsn("https://key@sentry.example.com/prefix/7");
		expect(parsed?.endpoint).toBe(
			"https://sentry.example.com/prefix/api/7/envelope/",
		);
	});

	// 未設定・設定ミスで「送ったつもり」にならないよう、判定は入口で閉じる。
	it.each([
		["空文字", ""],
		["空白のみ", "   "],
		["URLとして壊れている", "not-a-dsn"],
		["公開キーが無い", "https://o42.ingest.sentry.io/98765"],
		["プロジェクトIDが無い", "https://abc123@o42.ingest.sentry.io"],
	])("%s は null を返す", (_label, dsn) => {
		expect(parseSentryDsn(dsn)).toBeNull();
	});
});

describe("buildSentryEnvelope", () => {
	const input = {
		message: "credit refund failed after inference error",
		level: "error" as const,
		environment: "production",
		tags: { kind: "credit_refund_failed" },
		extra: { userId: "u1", reservedCredits: 30 },
		eventId: "0123456789abcdef0123456789abcdef",
		timestampMs: 1_760_000_000_000,
	};

	it("ヘッダ・アイテムヘッダ・イベントの3行を改行区切りで返す", () => {
		const lines = buildSentryEnvelope(input).trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event_id: input.eventId,
			sent_at: "2025-10-09T08:53:20.000Z",
		});
		expect(JSON.parse(lines[1] as string)).toEqual({ type: "event" });
	});

	it("イベント本体に level・environment・tags・extra を載せる", () => {
		const event = JSON.parse(
			buildSentryEnvelope(input).trimEnd().split("\n")[2] as string,
		);
		expect(event).toMatchObject({
			event_id: input.eventId,
			// Sentry の timestamp は秒
			timestamp: 1_760_000_000,
			level: "error",
			environment: "production",
			message: { formatted: input.message },
			extra: { userId: "u1", reservedCredits: 30 },
		});
		// クライアント由来のイベントと同じプロジェクトに送っても区別できるようにする
		expect(event.logger).toBe("worker");
		expect(event.tags).toEqual({
			kind: "credit_refund_failed",
			runtime: "workers",
		});
	});
});

describe("resolveServerEnvironment", () => {
	// クライアント側(sentry-client.ts)と同じ対応。片方だけ足すと同じ障害が
	// 2つの environment に割れて見える。
	it.each([
		["https://wine.nibo.sh", "production"],
		["https://wine-preview.niboshi.workers.dev", "preview"],
		["https://claude-x-wine-preview.niboshi.workers.dev", "preview"],
		["http://localhost:3000", "local"],
		["http://127.0.0.1:8787", "local"],
	])("%s → %s", (url, expected) => {
		expect(resolveServerEnvironment(url)).toBe(expected);
	});

	it("未設定・壊れた値は local に倒す(本番のイベントに混ぜない)", () => {
		expect(resolveServerEnvironment(undefined)).toBe("local");
		expect(resolveServerEnvironment("not a url")).toBe("local");
	});
});
