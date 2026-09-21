import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { aiChatRun, aiConversation, creditLedger } from "#/db/schema";
import { AI_REGION_QA_MODELS } from "#/lib/ai/config";
import { OpenRouterError } from "#/lib/ai/openrouter";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { REFUND_SUFFIX, SETTLE_SUFFIX } from "#/lib/credit/reservation";
import { BadRequestError, ConflictError, NotFoundError } from "#/lib/errors";
import {
	deleteAiConversation,
	getAiConversation,
	interruptExpiredAiRuns,
	listAiConversations,
	retryAiChatRun,
	sendAiChatMessage,
} from "./ai-conversation-service";
import {
	reclaimOrphanReservations,
	reserveCredits,
	settleReservation,
} from "./credit-service";

// 地域Q&Aの会話永続化(Issue #603)を実D1で検証する。
// 見るのは「所有権・順序・一意制約・同時実行・課金との整合・期限切れの決着」——
// 推論の中身(回答文の品質)は対象外で、OpenRouter はスタブする。

async function ledgerRowsOf(userId: string) {
	return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

async function balanceOf(userId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT balance FROM credit_balance WHERE user_id = ?",
	)
		.bind(userId)
		.first<{ balance: number }>();
	return row?.balance ?? 0;
}

async function seedUser(): Promise<string> {
	const id = crypto.randomUUID();
	await env.DB.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
		.bind(id, "chat-user", `${id}@example.test`)
		.run();
	return id;
}

function stubOpenRouterKey(): void {
	(env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY =
		"or-test";
}

function stubOpenRouter(respond: () => Promise<Response>): void {
	stubOpenRouterKey();
	vi.stubGlobal("fetch", async (input: unknown) => {
		const url = typeof input === "string" ? input : String(input);
		if (!url.startsWith("https://openrouter.ai/api/v1/")) {
			throw new Error(`OpenRouter 以外への接続は禁止: ${url}`);
		}
		return await respond();
	});
}

interface OrChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
}

function orChatMessage(text: string, usage: OrChatUsage): Response {
	return Response.json({
		choices: [{ finish_reason: "stop", message: { content: text } }],
		usage,
	});
}

function okAnswer(text: string): () => Promise<Response> {
	return async () =>
		orChatMessage(text, { prompt_tokens: 30, completion_tokens: 12 });
}

afterEach(() => {
	delete (env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
	vi.unstubAllGlobals();
});

async function waitFor(
	cond: () => Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function runStatusOf(runId: string): Promise<string | null> {
	const [row] = await db
		.select({ status: aiChatRun.status })
		.from(aiChatRun)
		.where(eq(aiChatRun.id, runId))
		.limit(1);
	return row?.status ?? null;
}

async function countRows(
	table: "ai_chat_message" | "ai_chat_run",
	conversationId: string,
): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT count(*) AS n FROM ${table} WHERE conversation_id = ?`,
	)
		.bind(conversationId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

const SEND_BASE = {
	regionId: "bourgogne",
	question: "シャブリの土壌は?",
} as const;

describe("会話のCRUDと所有権", () => {
	it("最初の送信で会話が作られ、取得・一覧できる", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("キンメリジャンです。"));

		const sent = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		expect(sent.status).toBe("ok");
		if (sent.status !== "ok")
			throw new Error(`expected ok, got ${sent.status}`);

		const detail = await getAiConversation(userId, sent.conversationId);
		expect(detail.regionId).toBe("bourgogne");
		expect(detail.title.length).toBeGreaterThan(0);
		expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(detail.messages.map((m) => m.sequence)).toEqual([1, 2]);
		expect(detail.messages[0]?.content).toBe(SEND_BASE.question);
		expect(detail.messages[1]?.content).toBe("キンメリジャンです。");
		expect(detail.runs).toHaveLength(1);
		expect(detail.runs[0]?.status).toBe("succeeded");

		const list = await listAiConversations(userId, {});
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.id).toBe(sent.conversationId);
		expect(list.nextCursor).toBeNull();
	});

	it("ダイアログを開いただけでは会話を作らない", async () => {
		const userId = await seedUser();
		const list = await listAiConversations(userId, {});
		expect(list.items).toHaveLength(0);
	});

	it("他人の会話は取得・削除できない(存在を推測させない)", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		stubOpenRouter(okAnswer("回答"));

		const sent = await sendAiChatMessage(owner, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (sent.status !== "ok")
			throw new Error(`expected ok, got ${sent.status}`);

		await expect(
			getAiConversation(other, sent.conversationId),
		).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			deleteAiConversation(other, sent.conversationId),
		).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			sendAiChatMessage(other, {
				...SEND_BASE,
				conversationId: sent.conversationId,
				sendId: crypto.randomUUID(),
			}),
		).rejects.toBeInstanceOf(NotFoundError);

		// 一覧にも混ざらない
		expect(await listAiConversations(other, {})).toMatchObject({
			items: [],
		});
	});

	it("同一地域の別会話・別地域の会話が混ざらない", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));

		const a = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		const b = await sendAiChatMessage(userId, {
			regionId: "bordeaux",
			question: "格付けは?",
			sendId: crypto.randomUUID(),
		});
		if (a.status !== "ok" || b.status !== "ok")
			throw new Error("expected ok results");
		expect(a.conversationId).not.toBe(b.conversationId);

		const all = await listAiConversations(userId, {});
		expect(all.items).toHaveLength(2);
		const filtered = await listAiConversations(userId, {
			regionId: "bourgogne",
		});
		expect(filtered.items.map((c) => c.id)).toEqual([a.conversationId]);

		// 別地域の文脈で既存会話へ送ると 400(履歴を引き継がない)
		await expect(
			sendAiChatMessage(userId, {
				conversationId: a.conversationId,
				regionId: "bordeaux",
				question: "格付けは?",
				sendId: crypto.randomUUID(),
			}),
		).rejects.toBeInstanceOf(BadRequestError);
	});

	it("連続送信で順序が連番になる", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));

		const first = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (first.status !== "ok")
			throw new Error(`expected ok, got ${first.status}`);
		const second = await sendAiChatMessage(userId, {
			...SEND_BASE,
			conversationId: first.conversationId,
			question: "2問目",
			sendId: crypto.randomUUID(),
		});
		expect(second.status).toBe("ok");

		const detail = await getAiConversation(userId, first.conversationId);
		expect(detail.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
		expect(detail.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});
});

describe("送信IDの冪等と同時実行制御", () => {
	it("同一送信IDの再送は再推論・再課金しない", async () => {
		const userId = await seedUser();
		let calls = 0;
		stubOpenRouter(async () => {
			calls += 1;
			return orChatMessage("回答", {
				prompt_tokens: 30,
				completion_tokens: 12,
			});
		});
		const sendId = crypto.randomUUID();

		const first = await sendAiChatMessage(userId, { ...SEND_BASE, sendId });
		expect(first.status).toBe("ok");
		const ledgerBefore = await ledgerRowsOf(userId);

		const replay = await sendAiChatMessage(userId, { ...SEND_BASE, sendId });
		expect(replay.status).toBe("ok");
		if (replay.status === "ok" && first.status === "ok") {
			expect(replay.answer).toBe(first.answer);
			expect(replay.conversationId).toBe(first.conversationId);
		}
		expect(calls).toBe(1);
		expect(await ledgerRowsOf(userId)).toHaveLength(ledgerBefore.length);
	});

	it("同一会話への同時送信は一方が競合エラーになり課金が重複しない", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));

		const first = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (first.status !== "ok")
			throw new Error(`expected ok, got ${first.status}`);

		const settled = await Promise.allSettled([
			sendAiChatMessage(userId, {
				...SEND_BASE,
				conversationId: first.conversationId,
				question: "同時A",
				sendId: crypto.randomUUID(),
			}),
			sendAiChatMessage(userId, {
				...SEND_BASE,
				conversationId: first.conversationId,
				question: "同時B",
				sendId: crypto.randomUUID(),
			}),
		]);
		const ok = settled.filter((r) => r.status === "fulfilled");
		const ng = settled.filter((r) => r.status === "rejected");
		expect(ok).toHaveLength(1);
		expect(ng).toHaveLength(1);
		expect((ng[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			ConflictError,
		);

		// 課金は勝者の1回ぶんだけ
		const consumes = (await ledgerRowsOf(userId)).filter(
			(r) => r.type === "consume",
		);
		expect(consumes).toHaveLength(2);
	});

	it("同一送信IDの同時送信は単一の予約に収まる", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));
		const sendId = crypto.randomUUID();

		const settled = await Promise.allSettled([
			sendAiChatMessage(userId, { ...SEND_BASE, sendId }),
			sendAiChatMessage(userId, { ...SEND_BASE, sendId }),
		]);
		for (const r of settled) {
			expect(r.status).toBe("fulfilled");
			if (r.status === "fulfilled") {
				expect(["ok", "pending"]).toContain(r.value.status);
			}
		}
		const consumes = (await ledgerRowsOf(userId)).filter(
			(r) => r.type === "consume",
		);
		expect(consumes).toHaveLength(1);
	});

	it("別会話への同時送信は互いに干渉しない", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));

		const settled = await Promise.allSettled([
			sendAiChatMessage(userId, { ...SEND_BASE, sendId: crypto.randomUUID() }),
			sendAiChatMessage(userId, {
				regionId: "bordeaux",
				question: "格付けは?",
				sendId: crypto.randomUUID(),
			}),
		]);
		expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		expect((await listAiConversations(userId, {})).items).toHaveLength(2);
	});
});

describe("失敗・再試行", () => {
	it("推論失敗時は予約を全額返却し、runは失敗で残る", async () => {
		const userId = await seedUser();
		stubOpenRouter(() => Promise.reject(new Error("AI unavailable")));

		// OpenRouterError(HttpError派生)は単発経路と同様にそのまま伝播する。
		// 予約の返却は finish が済ませており、例外の握り潰しは起きない(#158)。
		await expect(
			sendAiChatMessage(userId, { ...SEND_BASE, sendId: crypto.randomUUID() }),
		).rejects.toBeInstanceOf(OpenRouterError);
		expect(await balanceOf(userId)).toBe(MONTHLY_CREDITS_FREE);

		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);

		const list = await listAiConversations(userId, {});
		expect(list.items).toHaveLength(1);
		const detail = await getAiConversation(userId, list.items[0]?.id ?? "");
		// 失敗した質問は確認でき、未完了表示が永久に残らず再試行できる
		expect(detail.messages.map((m) => m.role)).toEqual(["user"]);
		expect(detail.runs[0]?.status).toBe("failed");
		expect(detail.runs[0]?.retryable).toBe(true);

		// 再試行は新しい送信ID・課金requestIdで、質問を重複追加しない
		stubOpenRouter(okAnswer("復旧回答"));
		const retried = await retryAiChatRun(userId, {
			conversationId: detail.id,
			runId: detail.runs[0]?.id ?? "",
			sendId: crypto.randomUUID(),
		});
		expect(retried.status).toBe("ok");
		const after = await getAiConversation(userId, detail.id);
		expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(after.messages[1]?.content).toBe("復旧回答");
		expect(after.runs).toHaveLength(2);
	});

	it("残高不足は予約せず質問を残し、回復後の再試行で進める", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));
		// 月次付与は予約時に走るため、先に1往復して付与を確定させてから残高を空にする。
		// 付与済みの月は再付与されないので、残高0がそのまま残る。
		const first = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (first.status !== "ok")
			throw new Error(`expected ok, got ${first.status}`);
		await env.DB.prepare(
			"UPDATE credit_balance SET balance = 0 WHERE user_id = ?",
		)
			.bind(userId)
			.run();

		const consumesBefore = (await ledgerRowsOf(userId)).filter(
			(r) => r.type === "consume",
		).length;
		const sent = await sendAiChatMessage(userId, {
			...SEND_BASE,
			conversationId: first.conversationId,
			question: "残高不足の質問",
			sendId: crypto.randomUUID(),
		});
		expect(sent.status).toBe("blocked");
		if (sent.status !== "blocked") throw new Error("expected blocked");
		if (!("balance" in sent)) throw new Error("expected fresh blocked result");

		// 消費も推論も起きていない
		expect(
			(await ledgerRowsOf(userId)).filter((r) => r.type === "consume"),
		).toHaveLength(consumesBefore);

		const detail = await getAiConversation(userId, sent.conversationId);
		// 予約が成立しなかった質問も残り、再試行できる
		expect(detail.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(detail.messages[2]?.content).toBe("残高不足の質問");
		expect(detail.runs[0]?.status).toBe("blocked");

		// 残高を戻して再試行する
		await env.DB.prepare(
			`UPDATE credit_balance SET balance = ${MONTHLY_CREDITS_FREE} WHERE user_id = ?`,
		)
			.bind(userId)
			.run();
		const retried = await retryAiChatRun(userId, {
			conversationId: detail.id,
			runId: detail.runs[0]?.id ?? "",
			sendId: crypto.randomUUID(),
		});
		expect(retried.status).toBe("ok");
	});

	it("キー未設定は予約前に検知し、会話も台帳も作らない", async () => {
		const userId = await seedUser();
		// afterEach でキーを消している状態 = 未設定。フォールバックしない。

		await expect(
			sendAiChatMessage(userId, { ...SEND_BASE, sendId: crypto.randomUUID() }),
		).rejects.toMatchObject({ status: 503 });
		expect(await listAiConversations(userId, {})).toMatchObject({
			items: [],
		});
		expect(await ledgerRowsOf(userId)).toHaveLength(0);
	});

	it("他人の試行は再試行できない", async () => {
		const owner = await seedUser();
		const other = await seedUser();
		stubOpenRouter(() => Promise.reject(new Error("AI unavailable")));
		await expect(
			sendAiChatMessage(owner, { ...SEND_BASE, sendId: crypto.randomUUID() }),
		).rejects.toThrow();
		const detail = await getAiConversation(
			owner,
			(await listAiConversations(owner, {})).items[0]?.id ?? "",
		);
		await expect(
			retryAiChatRun(other, {
				conversationId: detail.id,
				runId: detail.runs[0]?.id ?? "",
				sendId: crypto.randomUUID(),
			}),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("期限切れと遅延完了", () => {
	async function startGatedSend(userId: string, conversationId?: string) {
		let release!: (v: Response) => void;
		const gate = new Promise<Response>((resolve) => {
			release = resolve;
		});
		stubOpenRouter(() => gate);
		const pending = sendAiChatMessage(userId, {
			...SEND_BASE,
			...(conversationId ? { conversationId } : {}),
			sendId: crypto.randomUUID(),
		});
		// run 行ができるまで待つ
		let runId = "";
		await waitFor(async () => {
			const rows = await db
				.select({ id: aiChatRun.id })
				.from(aiChatRun)
				.where(eq(aiChatRun.userId, userId))
				.limit(10);
			if (rows.length > 0) {
				runId = rows[rows.length - 1]?.id ?? "";
				return true;
			}
			return false;
		});
		return { pending, release, runId };
	}

	it("実行期限を過ぎたrunは中断へ遷移し、再試行できる", async () => {
		const userId = await seedUser();
		const { pending, release, runId } = await startGatedSend(userId);
		// Worker中断を模擬: 期限を過去にして割り込ませる
		await env.DB.prepare("UPDATE ai_chat_run SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, runId)
			.run();
		expect(await interruptExpiredAiRuns(userId)).toBeGreaterThanOrEqual(1);
		expect(await runStatusOf(runId)).toBe("interrupted");

		// 遅れて届いたLLM応答は試行ID・状態・期限で拒否され、課金されない
		release(await okAnswer("遅延回答")());
		const responded = await (async () => {
			try {
				return await pending;
			} catch (e) {
				return e;
			}
		})();
		expect(responded).toBeInstanceOf(ConflictError);

		// 予約は返却され、確定は起きない
		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);

		// 中断した質問は再試行できる
		stubOpenRouter(okAnswer("再試行の回答"));
		const list = await listAiConversations(userId, {});
		const detail = await getAiConversation(userId, list.items[0]?.id ?? "");
		const target = detail.runs.find((r) => r.id === runId);
		expect(target?.retryable).toBe(true);
		const retried = await retryAiChatRun(userId, {
			conversationId: detail.id,
			runId,
			sendId: crypto.randomUUID(),
		});
		expect(retried.status).toBe("ok");
	});

	it("孤児予約の回収と遅延完了が重なっても二重返金しない", async () => {
		const userId = await seedUser();
		const { pending, release, runId } = await startGatedSend(userId);

		// 期限切れ + 孤児年齢到達を模擬し、先に回収を走らせる
		await env.DB.prepare("UPDATE ai_chat_run SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, runId)
			.run();
		const [run] = await db
			.select({ billingRequestId: aiChatRun.billingRequestId })
			.from(aiChatRun)
			.where(eq(aiChatRun.id, runId))
			.limit(1);
		await env.DB.prepare(
			"UPDATE credit_ledger SET created_at = ? WHERE request_id = ?",
		)
			.bind(Date.now() - 11 * 60 * 1000, run?.billingRequestId ?? "")
			.run();
		await reclaimOrphanReservations(userId);

		// 遅延完了の返却は既存の返却と相互排他で no-op になる
		release(await okAnswer("遅延回答")());
		const responded = await (async () => {
			try {
				return await pending;
			} catch (e) {
				return e;
			}
		})();
		expect(responded).toBeInstanceOf(ConflictError);

		const rows = await ledgerRowsOf(userId);
		expect(
			rows.filter((r) => r.requestId?.endsWith(REFUND_SUFFIX)),
		).toHaveLength(1);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(false);
	});
});

describe("削除", () => {
	it("生成中の削除は競合エラーになり、完了後に削除できる", async () => {
		const userId = await seedUser();
		let release!: (v: Response) => void;
		const gate = new Promise<Response>((resolve) => {
			release = resolve;
		});
		stubOpenRouter(() => gate);
		const sendId = crypto.randomUUID();
		const pending = sendAiChatMessage(userId, { ...SEND_BASE, sendId });
		await waitFor(async () => {
			const list = await listAiConversations(userId, {});
			return list.items.length === 1;
		});
		const conversationId = (await listAiConversations(userId, {})).items[0]?.id;
		if (!conversationId) throw new Error("conversation not created");

		await expect(
			deleteAiConversation(userId, conversationId),
		).rejects.toBeInstanceOf(ConflictError);

		release(await okAnswer("回答")());
		const sent = await pending;
		expect(sent.status).toBe("ok");

		expect(await deleteAiConversation(userId, conversationId)).toEqual({
			ok: true,
		});
		await expect(
			getAiConversation(userId, conversationId),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it("削除はメッセージ・試行を連動して消し、課金台帳は残す", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));
		const sent = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (sent.status !== "ok")
			throw new Error(`expected ok, got ${sent.status}`);
		const ledgerBefore = await ledgerRowsOf(userId);
		expect(ledgerBefore.length).toBeGreaterThan(0);

		await deleteAiConversation(userId, sent.conversationId);
		expect(await countRows("ai_chat_message", sent.conversationId)).toBe(0);
		expect(await countRows("ai_chat_run", sent.conversationId)).toBe(0);
		// 会話単位の削除で課金台帳や残高は変更しない
		expect((await ledgerRowsOf(userId)).length).toBe(ledgerBefore.length);
		expect(await balanceOf(userId)).toBe(await balanceOf(userId));
	});

	it("ユーザ削除で会話が連動して消える", async () => {
		const userId = await seedUser();
		stubOpenRouter(okAnswer("回答"));
		const sent = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (sent.status !== "ok")
			throw new Error(`expected ok, got ${sent.status}`);

		await db.delete(user).where(eq(user.id, userId));
		expect(await countRows("ai_chat_message", sent.conversationId)).toBe(0);
		expect(await countRows("ai_chat_run", sent.conversationId)).toBe(0);
		const convs = await db
			.select({ id: aiConversation.id })
			.from(aiConversation)
			.where(eq(aiConversation.id, sent.conversationId));
		expect(convs).toHaveLength(0);
	});
});

describe("履歴の上限分離と課金の整合", () => {
	it("長い会話でもLLMへは直近の往復だけを渡す", async () => {
		const userId = await seedUser();
		const bodies: string[] = [];
		stubOpenRouterKey();
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const url = typeof input === "string" ? input : String(input);
			if (!url.startsWith("https://openrouter.ai/api/v1/")) {
				throw new Error(`OpenRouter 以外への接続は禁止: ${url}`);
			}
			bodies.push(typeof init?.body === "string" ? init.body : "");
			return orChatMessage("回答", {
				prompt_tokens: 30,
				completion_tokens: 12,
			});
		});

		const first = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		if (first.status !== "ok")
			throw new Error(`expected ok, got ${first.status}`);
		for (let i = 2; i <= 6; i++) {
			const r = await sendAiChatMessage(userId, {
				...SEND_BASE,
				conversationId: first.conversationId,
				question: `質問${i}`,
				sendId: crypto.randomUUID(),
			});
			expect(r.status).toBe("ok");
		}

		// 保存は全件(6往復=12件)残る
		const detail = await getAiConversation(userId, first.conversationId);
		expect(detail.messages).toHaveLength(12);

		// LLM投入は system + 直近8件 + 新規質問に収まる
		const last = JSON.parse(bodies[bodies.length - 1] ?? "{}") as {
			messages: { role: string }[];
		};
		expect(last.messages[0]?.role).toBe("system");
		expect(last.messages[last.messages.length - 1]?.role).toBe("user");
		const history = last.messages.slice(1, -1);
		expect(history.length).toBeLessThanOrEqual(8);
	});

	it("確定・返却の冪等は共通入口のまま(月境界ガードを含む)", async () => {
		const userId = await seedUser();
		const res = await reserveCredits(
			userId,
			{ microUsd: 5000, tokens: 5 },
			"ask_region_chat:month-guard",
		);
		if (!res.ok) throw new Error("reserve failed");
		const before = await balanceOf(userId);

		// 月替わりを模擬: 残高の属月だけ進める
		await env.DB.prepare(
			"UPDATE credit_balance SET period_month = ? WHERE user_id = ?",
		)
			.bind("2099-01", userId)
			.run();
		await settleReservation(userId, "ask_region_chat:month-guard", 5, {
			microUsd: 0,
			tokens: 0,
		});

		// 確定の証跡は残るが、リセット後の残高に差分は混入しない
		const rows = await ledgerRowsOf(userId);
		expect(
			rows.some((r) => r.requestId === "ask_region_chat:month-guard:settle"),
		).toBe(true);
		expect(await balanceOf(userId)).toBe(before);
	});

	it("成功時は実測で確定し、試行にモデル・プロンプト版が残る", async () => {
		const userId = await seedUser();
		stubOpenRouter(async () =>
			orChatMessage("回答", { prompt_tokens: 30, completion_tokens: 12 }),
		);
		const sent = await sendAiChatMessage(userId, {
			...SEND_BASE,
			sendId: crypto.randomUUID(),
		});
		expect(sent.status).toBe("ok");

		const rows = await ledgerRowsOf(userId);
		expect(rows.some((r) => r.requestId?.endsWith(SETTLE_SUFFIX))).toBe(true);
		expect(rows.some((r) => r.requestId?.endsWith(REFUND_SUFFIX))).toBe(false);

		const [run] = await db
			.select()
			.from(aiChatRun)
			.where(
				and(eq(aiChatRun.userId, userId), eq(aiChatRun.status, "succeeded")),
			)
			.limit(1);
		expect(run?.modelId).toBe(AI_REGION_QA_MODELS.gemma4.id);
		expect(run?.promptName).toBe("region-qa-system");
		expect(run?.promptSource).toBeDefined();
		expect(run?.billingRequestId.startsWith("ask_region_chat:")).toBe(true);
	});
});
