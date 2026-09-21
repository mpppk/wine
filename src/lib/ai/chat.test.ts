import { describe, expect, it } from "vitest";
import {
	AI_CHAT_RUN_TIMEOUT_MS,
	buildChatTitle,
	CHAT_RUN_ERROR_KINDS,
	CHAT_RUN_STATUSES,
	CHAT_TITLE_MAX_CHARS,
	filterCompletedMessages,
	isRetryableChatRunStatus,
	isTerminalChatRunStatus,
	selectLlmHistory,
	toChatRunErrorKind,
	validateChatQuestion,
	validateChatSendId,
} from "./chat";
import { AI_MAX_HISTORY_MESSAGES, AI_MAX_QUESTION_CHARS } from "./config";

describe("buildChatTitle", () => {
	it("短い質問はそのままタイトルになる", () => {
		expect(buildChatTitle("主なブドウ品種は?")).toBe("主なブドウ品種は?");
	});

	it("長い質問は先頭を切り出す(LLM不使用)", () => {
		const q = `あ${"い".repeat(100)}`;
		const title = buildChatTitle(q);
		expect(title.length).toBe(CHAT_TITLE_MAX_CHARS + 1);
		expect(title.endsWith("…")).toBe(true);
		expect(q.startsWith(title.slice(0, -1))).toBe(true);
	});

	it("空白は正規化される", () => {
		expect(buildChatTitle("  土壌は?\nどんな  ")).toBe("土壌は? どんな");
	});
});

describe("filterCompletedMessages / selectLlmHistory", () => {
	it("成功した往復だけを残す", () => {
		const kept = filterCompletedMessages([
			{
				role: "user",
				content: "Q1",
				sequence: 1,
				runId: "r1",
				runStatus: "succeeded",
			},
			{
				role: "assistant",
				content: "A1",
				sequence: 2,
				runId: "r1",
				runStatus: "succeeded",
			},
			{
				role: "user",
				content: "Q2",
				sequence: 3,
				runId: "r2",
				runStatus: "failed",
			},
		]);
		expect(kept).toEqual([
			{ role: "user", content: "Q1" },
			{ role: "assistant", content: "A1" },
			{ role: "user", content: "Q2" },
		]);
	});

	it("失敗試行の assistant 発言を除外する", () => {
		const kept = filterCompletedMessages([
			{
				role: "user",
				content: "Q1",
				sequence: 1,
				runId: "r1",
				runStatus: "failed",
			},
			{
				role: "assistant",
				content: "壊れた回答",
				sequence: 2,
				runId: "r1",
				runStatus: "failed",
			},
			{
				role: "assistant",
				content: "A1",
				sequence: 3,
				runId: "r2",
				runStatus: "succeeded",
			},
		]);
		expect(kept).toEqual([
			{ role: "user", content: "Q1" },
			{ role: "assistant", content: "A1" },
		]);
	});

	it("未完了(run中)の試行の assistant 発言を入れない", () => {
		const kept = filterCompletedMessages([
			{
				role: "user",
				content: "Q1",
				sequence: 1,
				runId: "r1",
				runStatus: "running",
			},
			{
				role: "assistant",
				content: "途中",
				sequence: 2,
				runId: "r1",
				runStatus: "running",
			},
		]);
		expect(kept).toEqual([{ role: "user", content: "Q1" }]);
	});

	it("run未関連付けの assistant 発言(捏造の可能性)を入れない", () => {
		const kept = filterCompletedMessages([
			{
				role: "assistant",
				content: "偽装",
				sequence: 1,
				runId: "r9",
				runStatus: "failed",
			},
		]);
		expect(kept).toEqual([]);
	});

	it("LLM投入は直近 AI_MAX_HISTORY_MESSAGES 件に切り詰める", () => {
		const messages = Array.from(
			{ length: AI_MAX_HISTORY_MESSAGES + 6 },
			(_, i) => ({
				role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
				content: `m${i}`,
				sequence: i + 1,
				runId: `r${i}`,
				runStatus: "succeeded" as const,
			}),
		);
		const history = selectLlmHistory(messages);
		expect(history).toHaveLength(AI_MAX_HISTORY_MESSAGES);
		expect(history[0]?.content).toBe(
			`m${messages.length - AI_MAX_HISTORY_MESSAGES}`,
		);
	});
});

describe("run status", () => {
	it("running のみが非終端", () => {
		expect(isTerminalChatRunStatus("running")).toBe(false);
		for (const s of [
			"succeeded",
			"failed",
			"blocked",
			"interrupted",
		] as const) {
			expect(isTerminalChatRunStatus(s)).toBe(true);
		}
	});

	it("failed/blocked/interrupted が再試行対象", () => {
		expect(isRetryableChatRunStatus("failed")).toBe(true);
		expect(isRetryableChatRunStatus("blocked")).toBe(true);
		expect(isRetryableChatRunStatus("interrupted")).toBe(true);
		expect(isRetryableChatRunStatus("running")).toBe(false);
		expect(isRetryableChatRunStatus("succeeded")).toBe(false);
	});

	it("実行期限は孤児予約の猶予と整合する", () => {
		// credit-service の ORPHAN_GRACE_MS(10分)と同じ値にすること。
		// 短くすると「runは中断表示なのに予約は未回収」の窓ができる。
		expect(AI_CHAT_RUN_TIMEOUT_MS).toBe(10 * 60 * 1000);
	});
});

describe("語彙の固定", () => {
	it("試行の状態は5値で固定する", () => {
		// DB の status 列・UI の出し分け・再試行可否がこの語彙に依存するため、
		// 増減時は全経路の追随が必要。黙って変えない。
		expect(CHAT_RUN_STATUSES).toEqual([
			"running",
			"succeeded",
			"failed",
			"blocked",
			"interrupted",
		]);
	});

	it("失敗種別は3値で固定する", () => {
		expect(CHAT_RUN_ERROR_KINDS).toEqual(["llm", "conflict", "persistence"]);
	});

	it("toChatRunErrorKind は未知値を落とす", () => {
		expect(toChatRunErrorKind("llm")).toBe("llm");
		expect(toChatRunErrorKind("evil")).toBeNull();
		expect(toChatRunErrorKind(null)).toBeNull();
	});
});

describe("validation", () => {
	it("空の質問を弾く", () => {
		expect(validateChatQuestion("   ")).not.toBeNull();
	});

	it(`質問は${AI_MAX_QUESTION_CHARS}文字まで`, () => {
		expect(validateChatQuestion("あ".repeat(AI_MAX_QUESTION_CHARS))).toBeNull();
		expect(
			validateChatQuestion("あ".repeat(AI_MAX_QUESTION_CHARS + 1)),
		).not.toBeNull();
	});

	it("送信IDの空・長すぎを弾く", () => {
		expect(validateChatSendId("")).not.toBeNull();
		expect(validateChatSendId(crypto.randomUUID())).toBeNull();
		expect(validateChatSendId("x".repeat(81))).not.toBeNull();
	});
});
