import type { SQL } from "drizzle-orm";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { aiChatMessage, aiChatRun, aiConversation } from "#/db/schema";
import {
	AI_CHAT_RUN_TIMEOUT_MS,
	buildChatTitle,
	CHAT_LIST_MAX_PAGE_SIZE,
	CHAT_LIST_PAGE_SIZE,
	CHAT_SAVED_HISTORY_PAGE_SIZE,
	type ChatRunErrorKind,
	type ChatRunStatus,
	filterCompletedMessages,
	isRetryableChatRunStatus,
	toChatRunErrorKind,
	validateChatQuestion,
	validateChatSendId,
} from "#/lib/ai/chat";
import {
	estimateRegionQaReserveCharge,
	type RegionQaModelKey,
} from "#/lib/ai/config";
import { REGION_QA_SYSTEM_PROMPT } from "#/lib/ai/managed-prompts";
import { OpenRouterError } from "#/lib/ai/openrouter";
import {
	buildRegionChatMessages,
	buildRegionContext,
	type ChatMessage,
	estimateInputTokens,
} from "#/lib/ai/region-qa";
import {
	BadRequestError,
	ConflictError,
	HttpError,
	NotFoundError,
} from "#/lib/errors";
import { logWarn } from "#/lib/logger";
import { getManagedPrompt } from "#/lib/observability/langfuse-prompt";
import {
	buildRegionQaLogBase,
	requireOpenRouterApiKey,
	resolveRegionContext,
	resolveRegionQaModel,
	runRegionQaTurn,
} from "#/lib/services/ai-service";
import { getBalance } from "#/lib/services/credit-service";
import {
	beginMeteredInference,
	finishMeteredInference,
} from "#/lib/services/metered-inference";

// 地域Q&Aの会話の永続化(Issue #603)。Web の server function を薄い入口にし、
// 一覧/取得/送信/再試行/削除をここに集約する。MCP の `ask_region`
// (単発/履歴指定)は `answerRegionQuestion` のまま変えず、同じ推論コア
// (`runRegionQaTurn`)を使うことで互換を保つ。
//
// 推論・課金・観測は既存SSOTを再利用し複製しない:
//  - 予約→推論→確定は begin/finishMeteredInference のみを通す
//    (db.batch原子化 + requestId冪等 + 条件付きUPDATE + 月境界ガードは
//    credit-service 側のまま。ここに別の課金処理を書かない)
//  - Langfuse は ctx.recordGeneration() のみを通す(startObservation 直書き禁止)
//  - プロンプトは getManagedPrompt のみを通す(LangfuseClient 直書き禁止)
//  - モデルID・単価は集約後の config.ts / ai-pricing.ts を使う
//
// 順序制約(#245): D1 読み・env 解決・入力検証は予約より前に済ませる。
// 送信IDの重複確認と同一会話の実行権取得・質問/run作成も D1 で先に行い、
// 競合に負けたリクエストは課金・推論を開始しない。

/** 課金台帳の request_id の接頭辞。単発(`ask_region:`)と区別して追跡できるようにする */
const CHAT_BILLING_PREFIX = "ask_region_chat:";

/** 他人の会話の存在を推測させないための統一メッセージ */
const CONVERSATION_NOT_FOUND_MESSAGE = "会話が見つかりません。";

/** 生成中の会話への操作を拒否するときの利用者向け文言 */
const CONVERSATION_BUSY_MESSAGE =
	"回答を生成中です。完了または中断の確定後に操作してください。";

export interface ConversationSummary {
	id: string;
	regionId: string;
	aopId: string | null;
	title: string;
	updatedAtMs: number;
	createdAtMs: number;
}

export interface ChatMessageView {
	id: string;
	role: "user" | "assistant";
	content: string;
	sequence: number;
	runId: string | null;
	createdAtMs: number;
}

export interface ChatRunView {
	id: string;
	status: ChatRunStatus;
	userSequence: number;
	modelKey: string;
	errorKind: string | null;
	retryable: boolean;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface ConversationDetail extends ConversationSummary {
	messages: ChatMessageView[];
	totalMessages: number;
	runs: ChatRunView[];
}

export interface ConversationList {
	items: ConversationSummary[];
	nextCursor: string | null;
}

export type SendChatResult =
	| {
			status: "ok";
			conversationId: string;
			runId: string;
			answer: string;
			actualTokens: number;
			balance: number;
	  }
	| {
			status: "blocked";
			conversationId: string;
			runId: string;
			balance: number;
			required: number;
	  }
	| {
			status: "blocked";
			conversationId: string;
			runId: string;
			errorKind: string;
			retryable: true;
	  }
	| { status: "pending"; conversationId: string; runId: string }
	| {
			status: "failed" | "interrupted";
			conversationId: string;
			runId: string;
			errorKind: string | null;
			retryable: true;
	  };

export interface SendChatInput {
	/** 既存会話への送信。NULL/省略時は新規会話を作成する */
	conversationId?: string | null;
	/** 新規作成時は必須。既存会話への送信時は会話の文脈と一致しなければならない */
	regionId: string;
	aopId?: string;
	question: string;
	/** クライアント採番の送信ID(冪等キー) */
	sendId: string;
	/** モデルの明示指定。省略時はプロフィール設定 */
	model?: RegionQaModelKey;
}

export interface RetryChatInput {
	conversationId: string;
	/** 再試行対象の試行(failed/blocked/interrupted) */
	runId: string;
	/** 新しい送信ID(再試行は新しい試行ID・課金requestIdを使う) */
	sendId: string;
	model?: RegionQaModelKey;
}

type ConversationRow = typeof aiConversation.$inferSelect;
type RunRow = typeof aiChatRun.$inferSelect;

function toSummary(row: ConversationRow): ConversationSummary {
	return {
		id: row.id,
		regionId: row.regionId,
		aopId: row.aopId,
		title: row.title,
		updatedAtMs: row.updatedAt.getTime(),
		createdAtMs: row.createdAt.getTime(),
	};
}

/** 所有する会話を1件読む。他人の会話・存在しないIDは区別せず 404 */
async function loadOwnedConversation(
	userId: string,
	conversationId: string,
): Promise<ConversationRow> {
	const [row] = await db
		.select()
		.from(aiConversation)
		.where(
			and(
				eq(aiConversation.id, conversationId),
				eq(aiConversation.userId, userId),
			),
		)
		.limit(1);
	if (!row) throw new NotFoundError(CONVERSATION_NOT_FOUND_MESSAGE);
	return row;
}

/** 所有する試行を1件読む。他人の試行・存在しないIDは区別せず 404 */
async function loadOwnedRun(userId: string, runId: string): Promise<RunRow> {
	const [row] = await db
		.select()
		.from(aiChatRun)
		.where(and(eq(aiChatRun.id, runId), eq(aiChatRun.userId, userId)))
		.limit(1);
	if (!row) throw new NotFoundError(CONVERSATION_NOT_FOUND_MESSAGE);
	return row;
}

/** 送信IDによる重複確認(所有者スコープ)。再送は再推論・再課金しない */
async function findRunBySendId(
	userId: string,
	sendId: string,
): Promise<RunRow | null> {
	const [row] = await db
		.select()
		.from(aiChatRun)
		.where(and(eq(aiChatRun.sendId, sendId), eq(aiChatRun.userId, userId)))
		.limit(1);
	return row ?? null;
}

/**
 * 送信IDによる重複確認(競合時の再読み込み用)。勝者のコミットがこの試行の
 * 参照より遅れることがあるため、短い間だけ再試行する。
 */
async function findSettledRunBySendId(
	userId: string,
	sendId: string,
): Promise<RunRow | null> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const found = await findRunBySendId(userId, sendId);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return null;
}

/** 会話内の最大 sequence。0始まりの集計が空なら 0 を返す */
async function maxSequence(conversationId: string): Promise<number> {
	const [row] = await db
		.select({ maxSeq: sql<number | null>`max(${aiChatMessage.sequence})` })
		.from(aiChatMessage)
		.where(eq(aiChatMessage.conversationId, conversationId));
	return row?.maxSeq ?? 0;
}

async function countMessages(conversationId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(aiChatMessage)
		.where(eq(aiChatMessage.conversationId, conversationId));
	return row?.count ?? 0;
}

/** 試行が生んだ assistant 発言(成功時の回答の復元用) */
async function findAssistantMessageByRun(
	runId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ content: aiChatMessage.content })
		.from(aiChatMessage)
		.where(
			and(eq(aiChatMessage.runId, runId), eq(aiChatMessage.role, "assistant")),
		)
		.limit(1);
	return row?.content ?? null;
}

/**
 * 保存済みメッセージを会話順で読む。LLM投入用は最新ページだけを使う
 * (履歴全件を毎回読み込まない)。
 */
async function loadRecentSavedMessages(
	conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
	const rows = await db
		.select({
			role: aiChatMessage.role,
			content: aiChatMessage.content,
			sequence: aiChatMessage.sequence,
			runId: aiChatMessage.runId,
			runStatus: aiChatRun.status,
		})
		.from(aiChatMessage)
		.leftJoin(aiChatRun, eq(aiChatMessage.runId, aiChatRun.id))
		.where(eq(aiChatMessage.conversationId, conversationId))
		.orderBy(desc(aiChatMessage.sequence))
		.limit(CHAT_SAVED_HISTORY_PAGE_SIZE);
	const saved = rows.reverse().map((r) => ({
		role: r.role,
		content: r.content,
		sequence: r.sequence,
		runId: r.runId,
		runStatus: r.runStatus,
	}));
	// 成功した往復だけを残し、失敗/未完了の試行や偽装された assistant 発言を
	// モデル履歴に入れない。保存履歴の切り捨てとLLM投入の上限は別の軸。
	return filterCompletedMessages(saved);
}

/** 試行が推論を開始・継続できる状態か(試行ID・状態・期限で判定) */
function isRunAlive(
	run: { status: ChatRunStatus; expiresAt: Date } | undefined,
): boolean {
	if (!run) return false;
	if (run.status !== "running") return false;
	return run.expiresAt.getTime() > Date.now();
}

/**
 * 実行期限を過ぎた running を中断へ遷移させ、会話の実行権を解放する。
 * Worker終了で残った試行を再試行可能にするための遅延修復。クレジットの返却は
 * しない(回収は `reclaimOrphanReservations` に一本化し、二重機構を作らない)。
 */
export async function interruptExpiredAiRuns(
	userId: string,
	conversationId?: string,
): Promise<number> {
	const now = new Date();
	const expired = await db
		.select({ id: aiChatRun.id, conversationId: aiChatRun.conversationId })
		.from(aiChatRun)
		.where(
			and(
				eq(aiChatRun.userId, userId),
				...(conversationId
					? [eq(aiChatRun.conversationId, conversationId)]
					: []),
				eq(aiChatRun.status, "running"),
				lt(aiChatRun.expiresAt, now),
			),
		)
		.limit(100);
	for (const run of expired) {
		// 条件付き更新で中断へ遷移させる(既に終端していたら何もしない)。
		// 古い実行の遅延完了はこの状態遷移で拒否される。
		const [updated] = await db.batch([
			db
				.update(aiChatRun)
				.set({ status: "interrupted", finishedAt: now, updatedAt: now })
				.where(and(eq(aiChatRun.id, run.id), eq(aiChatRun.status, "running")))
				.returning({ id: aiChatRun.id }),
			db
				.update(aiConversation)
				.set({ activeRunId: null, activeRunExpiresAt: null })
				.where(
					and(
						eq(aiConversation.id, run.conversationId),
						eq(aiConversation.activeRunId, run.id),
					),
				),
		]);
		if (updated.length > 0) {
			logWarn("ai chat run interrupted after expiry", {
				userId,
				conversationId: run.conversationId,
				runId: run.id,
			});
		}
	}
	return expired.length;
}

/** 会話の実行権を解放する(この run が保持している場合のみ) */
async function releaseActiveRun(
	userId: string,
	conversationId: string,
	runId: string,
): Promise<void> {
	await db
		.update(aiConversation)
		.set({ activeRunId: null, activeRunExpiresAt: null })
		.where(
			and(
				eq(aiConversation.id, conversationId),
				eq(aiConversation.userId, userId),
				eq(aiConversation.activeRunId, runId),
			),
		);
}

function toErrorKind(e: unknown): ChatRunErrorKind {
	if (e instanceof ConflictError) return "conflict";
	if (e instanceof HttpError || e instanceof OpenRouterError) return "llm";
	return "persistence";
}

/** 利用者向けの失敗文言。詳細はサーバ側のログにだけ残す */
function toUserErrorMessage(kind: ChatRunErrorKind): string {
	if (kind === "conflict")
		return "生成の有効期限が切れたか、他のタブで操作されました。再試行してください。";
	return "回答の生成に失敗しました。再試行してください。";
}

export async function listAiConversations(
	userId: string,
	options?: { regionId?: string; limit?: number; cursor?: string },
): Promise<ConversationList> {
	const limit = Math.min(
		Math.max(options?.limit ?? CHAT_LIST_PAGE_SIZE, 1),
		CHAT_LIST_MAX_PAGE_SIZE,
	);
	const conditions: SQL[] = [eq(aiConversation.userId, userId)];
	if (options?.regionId) {
		conditions.push(eq(aiConversation.regionId, options.regionId));
	}
	if (options?.cursor) {
		const sep = options.cursor.lastIndexOf(":");
		if (sep > 0) {
			const t = Number(options.cursor.slice(0, sep));
			const id = options.cursor.slice(sep + 1);
			if (Number.isFinite(t) && id) {
				const at = new Date(t);
				const cursorCond = or(
					lt(aiConversation.updatedAt, at),
					and(eq(aiConversation.updatedAt, at), lt(aiConversation.id, id)),
				);
				if (cursorCond) conditions.push(cursorCond);
			}
		}
	}
	const rows = await db
		.select()
		.from(aiConversation)
		.where(and(...conditions))
		.orderBy(desc(aiConversation.updatedAt), desc(aiConversation.id))
		.limit(limit + 1);
	const items = rows.slice(0, limit).map(toSummary);
	const last = rows.length > limit ? items[items.length - 1] : null;
	return {
		items,
		nextCursor: last ? `${last.updatedAtMs}:${last.id}` : null,
	};
}

export async function getAiConversation(
	userId: string,
	conversationId: string,
	options?: { messageLimit?: number; beforeSequence?: number },
): Promise<ConversationDetail> {
	const conv = await loadOwnedConversation(userId, conversationId);
	const limit = Math.min(
		Math.max(options?.messageLimit ?? CHAT_SAVED_HISTORY_PAGE_SIZE, 1),
		CHAT_SAVED_HISTORY_PAGE_SIZE,
	);
	const messageConditions = [
		eq(aiChatMessage.conversationId, conversationId),
		eq(aiChatMessage.userId, userId),
		...(options?.beforeSequence !== undefined
			? [lt(aiChatMessage.sequence, options.beforeSequence)]
			: []),
	];
	const rows = await db
		.select({
			id: aiChatMessage.id,
			role: aiChatMessage.role,
			content: aiChatMessage.content,
			sequence: aiChatMessage.sequence,
			runId: aiChatMessage.runId,
			createdAt: aiChatMessage.createdAt,
			runStatus: aiChatRun.status,
		})
		.from(aiChatMessage)
		.leftJoin(aiChatRun, eq(aiChatMessage.runId, aiChatRun.id))
		.where(and(...messageConditions))
		.orderBy(desc(aiChatMessage.sequence))
		.limit(limit);
	const saved = rows.reverse();
	// 失敗試行の assistant 発言は表示にも出さない(成功時の回答と混ざらないようにする)。
	// ユーザ自身の質問は失敗後も確認でき、再試行できる。
	const visible = saved.filter((m) => {
		if (m.role === "user") return true;
		return m.runId === null || m.runStatus === "succeeded";
	});
	const runRows = await db
		.select()
		.from(aiChatRun)
		.where(
			and(
				eq(aiChatRun.conversationId, conversationId),
				eq(aiChatRun.userId, userId),
			),
		)
		.orderBy(desc(aiChatRun.createdAt))
		.limit(20);
	return {
		...toSummary(conv),
		messages: visible.map((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			sequence: m.sequence,
			runId: m.runId,
			createdAtMs: m.createdAt.getTime(),
		})),
		totalMessages: await countMessages(conversationId),
		runs: runRows.map((r) => ({
			id: r.id,
			status: r.status,
			userSequence: r.userSequence,
			modelKey: r.modelKey,
			errorKind: toChatRunErrorKind(r.errorKind),
			retryable: isRetryableChatRunStatus(r.status),
			createdAtMs: r.createdAt.getTime(),
			updatedAtMs: r.updatedAt.getTime(),
		})),
	};
}

export async function deleteAiConversation(
	userId: string,
	conversationId: string,
): Promise<{ ok: true }> {
	const conv = await loadOwnedConversation(userId, conversationId);
	// 期限切れの実行権はここで解放し、完了または中断確定後に削除できるようにする。
	await interruptExpiredAiRuns(userId, conversationId);
	if (conv.activeRunId) {
		const [fresh] = await db
			.select({ activeRunId: aiConversation.activeRunId })
			.from(aiConversation)
			.where(
				and(
					eq(aiConversation.id, conversationId),
					eq(aiConversation.userId, userId),
				),
			)
			.limit(1);
		if (fresh?.activeRunId) {
			// 生成中は削除を競合エラーにする
			throw new ConflictError(CONVERSATION_BUSY_MESSAGE);
		}
	}
	// 会話→メッセージ/runへ cascade する。課金台帳は削除・返金しない
	// (台帳は request_id 文字列参照のみでFKを持たない)。
	await db
		.delete(aiConversation)
		.where(
			and(
				eq(aiConversation.id, conversationId),
				eq(aiConversation.userId, userId),
			),
		);
	return { ok: true };
}

/** 既存試行の現在状態を返す(同一送信IDの再送用。再推論・再課金しない) */
async function replayRunResult(
	userId: string,
	run: RunRow,
): Promise<SendChatResult> {
	if (run.status === "succeeded") {
		const answer = await findAssistantMessageByRun(run.id);
		const { balance } = await getBalance(userId);
		if (answer === null) {
			// 回答の保存に失敗した成功試行は矛盾した状態。返金は済んでいるか
			// 孤児回収に任せるため、ここでは再試行可能な失敗として扱う。
			logWarn("ai chat run succeeded without answer", {
				userId,
				conversationId: run.conversationId,
				runId: run.id,
			});
			return {
				status: "failed",
				conversationId: run.conversationId,
				runId: run.id,
				errorKind: "persistence",
				retryable: true,
			};
		}
		return {
			status: "ok",
			conversationId: run.conversationId,
			runId: run.id,
			answer,
			actualTokens: run.actualTokens ?? 0,
			balance,
		};
	}
	if (run.status === "running") {
		if (run.expiresAt.getTime() <= Date.now()) {
			await interruptExpiredAiRuns(userId, run.conversationId);
			const next = await loadOwnedRun(userId, run.id);
			return {
				status: "interrupted",
				conversationId: next.conversationId,
				runId: next.id,
				errorKind: toChatRunErrorKind(next.errorKind),
				retryable: true,
			};
		}
		// 生成が続いていれば状態だけ返し、クライアントの再接続で自動再実行しない。
		// 完了していれば次回の同一送信IDの再送で保存回答を返す。
		return {
			status: "pending",
			conversationId: run.conversationId,
			runId: run.id,
		};
	}
	if (run.status === "blocked") {
		return {
			status: "blocked",
			conversationId: run.conversationId,
			runId: run.id,
			errorKind: "blocked",
			retryable: true,
		};
	}
	return {
		status: run.status,
		conversationId: run.conversationId,
		runId: run.id,
		errorKind: toChatRunErrorKind(run.errorKind),
		retryable: true,
	};
}

/**
 * 新規質問の送信。ダイアログを開いただけでは会話を作らず、最初の送信で作成する。
 * 正常応答は永続化が確認できてから成功として返す。
 */
export async function sendAiChatMessage(
	userId: string,
	input: SendChatInput,
): Promise<SendChatResult> {
	const questionError = validateChatQuestion(input.question);
	if (questionError) throw new BadRequestError(questionError);
	const sendIdError = validateChatSendId(input.sendId);
	if (sendIdError) throw new BadRequestError(sendIdError);
	const question = input.question.trim();

	// 送信IDによる重複確認。同じ送信IDの再送には保存結果を返し、再推論・再課金しない。
	const dup = await findRunBySendId(userId, input.sendId);
	if (dup) return replayRunResult(userId, dup);

	// 地域文脈の検証は予約より前に行う(静的マスタの存在・所属関係)。
	const context = resolveRegionContext(input.regionId, input.aopId);

	// 既存会話への送信時は所有権・文脈一致を確認する。期限切れの実行権は解放する。
	let conv: ConversationRow | null = null;
	if (input.conversationId) {
		conv = await loadOwnedConversation(userId, input.conversationId);
		if (
			conv.regionId !== input.regionId ||
			(conv.aopId ?? undefined) !== input.aopId
		) {
			throw new BadRequestError(
				"この会話とは異なる地域・AOPへの質問です。新しい会話を始めてください。",
			);
		}
		await interruptExpiredAiRuns(userId, conv.id);
	}

	// モデル・プロンプト・予算の解決は予約より前に済ませる(#245)。
	// 見積は組み上がったメッセージの実長から出す(Langfuse側の伸び縮みに追随する)。
	const { modelKey, model } = await resolveRegionQaModel(userId, input.model);
	const apiKey = requireOpenRouterApiKey();
	const managedPrompt = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
		region_context: buildRegionContext(context),
	});
	const history: ChatMessage[] = conv
		? await loadRecentSavedMessages(conv.id)
		: [];
	const messages = buildRegionChatMessages({
		system: managedPrompt.text,
		history,
		question,
	});
	const promptTokens = estimateInputTokens(messages);
	const estimate = estimateRegionQaReserveCharge(modelKey, promptTokens);
	const logBase = buildRegionQaLogBase(modelKey, model.id);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + AI_CHAT_RUN_TIMEOUT_MS);
	const runId = crypto.randomUUID();
	const billingRequestId = `${CHAT_BILLING_PREFIX}${crypto.randomUUID()}`;
	let conversationId: string;
	let userSequence: number;

	if (!conv) {
		// 新規会話。最初の送信で作成し、タイトルは先頭切り出し(LLM不使用)。
		conversationId = crypto.randomUUID();
		userSequence = 1;
		try {
			await db.batch([
				db.insert(aiConversation).values({
					id: conversationId,
					userId,
					regionId: input.regionId,
					aopId: input.aopId ?? null,
					title: buildChatTitle(question),
					activeRunId: runId,
					activeRunExpiresAt: expiresAt,
				}),
				db.insert(aiChatRun).values({
					id: runId,
					conversationId,
					userId,
					sendId: input.sendId,
					status: "running",
					question,
					userSequence: 1,
					modelKey,
					modelId: model.id,
					promptName: REGION_QA_SYSTEM_PROMPT.name,
					promptVersion: managedPrompt.ref?.version ?? null,
					promptSource: managedPrompt.source,
					billingRequestId,
					expiresAt,
				}),
				db.insert(aiChatMessage).values({
					id: crypto.randomUUID(),
					conversationId,
					userId,
					role: "user",
					content: question,
					sequence: 1,
					runId,
				}),
			]);
		} catch (e) {
			// 同一送信IDの競合に負けた場合は保存結果を返す(課金・推論は開始しない)。
			const raced = await findSettledRunBySendId(userId, input.sendId);
			if (raced) return replayRunResult(userId, raced);
			throw e;
		}
	} else {
		conversationId = conv.id;
		// 同一会話の実行権を取得する。競合に負けたリクエストは課金・推論を開始しない。
		const claimed = await db
			.update(aiConversation)
			.set({ activeRunId: runId, activeRunExpiresAt: expiresAt })
			.where(
				and(
					eq(aiConversation.id, conv.id),
					eq(aiConversation.userId, userId),
					sql`${aiConversation.activeRunId} IS NULL`,
				),
			)
			.returning({ id: aiConversation.id });
		if (claimed.length === 0) {
			const raced = await findSettledRunBySendId(userId, input.sendId);
			if (raced) return replayRunResult(userId, raced);
			throw new ConflictError(CONVERSATION_BUSY_MESSAGE);
		}
		userSequence = (await maxSequence(conv.id)) + 1;
		try {
			await db.batch([
				db.insert(aiChatRun).values({
					id: runId,
					conversationId,
					userId,
					sendId: input.sendId,
					status: "running",
					question,
					userSequence,
					modelKey,
					modelId: model.id,
					promptName: REGION_QA_SYSTEM_PROMPT.name,
					promptVersion: managedPrompt.ref?.version ?? null,
					promptSource: managedPrompt.source,
					billingRequestId,
					expiresAt,
				}),
				db.insert(aiChatMessage).values({
					id: crypto.randomUUID(),
					conversationId,
					userId,
					role: "user",
					content: question,
					sequence: userSequence,
					runId,
				}),
			]);
		} catch (e) {
			await releaseActiveRun(userId, conversationId, runId);
			const raced = await findSettledRunBySendId(userId, input.sendId);
			if (raced) return replayRunResult(userId, raced);
			throw e;
		}
	}

	// 永続化した課金requestIdで予約して推論を行う。ここから先の throw は
	// finish/abandon の返却に届く(予約より前の throw は予約を作っていない)。
	const begun = await beginMeteredInference(userId, {
		estimate,
		requestId: billingRequestId,
		logBase,
	});
	if (begun.blocked) {
		// 予約が成立しなかった質問も再試行可能な状態で残す。
		await db
			.update(aiChatRun)
			.set({ status: "blocked", finishedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(aiChatRun.id, runId), eq(aiChatRun.status, "running")));
		await releaseActiveRun(userId, conversationId, runId);
		return {
			status: "blocked",
			conversationId,
			runId,
			balance: begun.balance,
			required: begun.required,
		};
	}
	await db
		.update(aiChatRun)
		.set({
			reservedCredits: begun.reservation.reservedCredits,
			reservedMicroUsd: begun.reservation.reservedMicroUsd,
		})
		.where(eq(aiChatRun.id, runId));

	try {
		const done = await finishMeteredInference(
			userId,
			{ reservation: begun.reservation, logBase },
			async (ctx) => {
				// 開始前に試行が生きていることを確かめ、期限切れの遅延開始を避ける。
				const [alive] = await db
					.select({ status: aiChatRun.status, expiresAt: aiChatRun.expiresAt })
					.from(aiChatRun)
					.where(eq(aiChatRun.id, runId))
					.limit(1);
				if (!isRunAlive(alive)) {
					throw new ConflictError(
						"生成の有効期限が切れました。再試行してください。",
					);
				}
				const out = await runRegionQaTurn(
					{ apiKey, modelKey, model, messages, managedPrompt },
					ctx,
				);
				await persistChatSuccess({
					userId,
					conversationId,
					runId,
					answer: out.value,
					charge: out.charge,
				});
				return out;
			},
		);
		return {
			status: "ok",
			conversationId,
			runId,
			answer: done.value,
			actualTokens: done.charge.tokens,
			balance: done.balance,
		};
	} catch (e) {
		// finish が予約の返却まで済ませている。ここでは試行を実行権ごと決着させる。
		// 既に終端(期限切れ中断など)の試行は条件付き更新で触らない。
		const kind = toErrorKind(e);
		// 期限切れの遅延完了(conflict)は状態を上書きしない(中断への遷移を優先する)。
		// set に undefined を渡すと列の扱いが不定になるため、オブジェクトを作り分ける。
		const failedPatch =
			kind === "conflict"
				? { errorKind: kind, finishedAt: new Date(), updatedAt: new Date() }
				: {
						status: "failed" as const,
						errorKind: kind,
						finishedAt: new Date(),
						updatedAt: new Date(),
					};
		await db
			.update(aiChatRun)
			.set(failedPatch)
			.where(and(eq(aiChatRun.id, runId), eq(aiChatRun.status, "running")));
		await releaseActiveRun(userId, conversationId, runId);
		if (e instanceof ConflictError) throw e;
		if (e instanceof HttpError) throw e;
		logWarn("ai chat inference failed", {
			userId,
			conversationId,
			runId,
			errorKind: kind,
		});
		throw new HttpError(500, toUserErrorMessage(kind));
	}
}

/**
 * 回答の保存・run完了・会話更新。正常応答はこの永続化が確認できてから成功として返す。
 *
 * infer の中で行い、確定(settle)より前に置く——確定後に保存が落ちると
 * 「課金だけされて回答が無い」利用者被害になる。逆順(保存後に確定が落ちる)は
 * 「回答はあるのに返金される」側で、再送で保存結果を返すため利用者は損をしない。
 *
 * run の完了は試行ID・状態・期限の条件付き更新で行い、古い実行の遅延完了を拒否する。
 */
async function persistChatSuccess(args: {
	userId: string;
	conversationId: string;
	runId: string;
	answer: string;
	charge: { microUsd: number; tokens: number };
}): Promise<void> {
	const { userId, conversationId, runId, answer, charge } = args;
	const now = new Date();
	const assistantSequence = (await maxSequence(conversationId)) + 1;
	const [runUpdated] = await db.batch([
		db
			.update(aiChatRun)
			.set({
				status: "succeeded",
				actualTokens: charge.tokens,
				actualMicroUsd: charge.microUsd,
				finishedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(aiChatRun.id, runId),
					eq(aiChatRun.status, "running"),
					sql`${aiChatRun.expiresAt} > ${now.getTime()}`,
				),
			)
			.returning({ id: aiChatRun.id }),
		db.insert(aiChatMessage).values({
			id: crypto.randomUUID(),
			conversationId,
			userId,
			role: "assistant",
			content: answer,
			sequence: assistantSequence,
			runId,
		}),
		db
			.update(aiConversation)
			.set({ activeRunId: null, activeRunExpiresAt: null, updatedAt: now })
			.where(
				and(
					eq(aiConversation.id, conversationId),
					eq(aiConversation.userId, userId),
					eq(aiConversation.activeRunId, runId),
				),
			),
	]);
	if (runUpdated.length === 0) {
		// 期限切れ・中断確定後の遅延完了。finish の catch が予約を返却する。
		// 同一バッチの発言は残るが、run が成功でないため履歴の選択から除外される。
		logWarn("ai chat late completion rejected", {
			userId,
			conversationId,
			runId,
		});
		throw new ConflictError("生成の有効期限が切れました。再試行してください。");
	}
}

/**
 * 失敗した質問への明示的な再試行。新しい試行ID・課金requestIdを使い、
 * 質問本文を重複追加しない。再試行にも同時実行制御を適用する。
 */
export async function retryAiChatRun(
	userId: string,
	input: RetryChatInput,
): Promise<SendChatResult> {
	const sendIdError = validateChatSendId(input.sendId);
	if (sendIdError) throw new BadRequestError(sendIdError);
	const dup = await findRunBySendId(userId, input.sendId);
	if (dup) return replayRunResult(userId, dup);

	const conv = await loadOwnedConversation(userId, input.conversationId);
	const target = await loadOwnedRun(userId, input.runId);
	if (target.conversationId !== conv.id) {
		throw new NotFoundError(CONVERSATION_NOT_FOUND_MESSAGE);
	}
	if (target.status === "running") {
		throw new ConflictError(CONVERSATION_BUSY_MESSAGE);
	}
	if (!isRetryableChatRunStatus(target.status)) {
		throw new BadRequestError("この試行は再試行できません。");
	}
	await interruptExpiredAiRuns(userId, conv.id);

	const { modelKey, model } = await resolveRegionQaModel(userId, input.model);
	const apiKey = requireOpenRouterApiKey();
	const context = resolveRegionContext(conv.regionId, conv.aopId ?? undefined);
	const managedPrompt = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
		region_context: buildRegionContext(context),
	});
	// 会話を再開したときも保存済みの完了した往復から履歴を組み立てる。
	const history = await loadRecentSavedMessages(conv.id);
	const messages = buildRegionChatMessages({
		system: managedPrompt.text,
		history,
		question: target.question,
	});
	const promptTokens = estimateInputTokens(messages);
	const estimate = estimateRegionQaReserveCharge(modelKey, promptTokens);
	const logBase = buildRegionQaLogBase(modelKey, model.id);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + AI_CHAT_RUN_TIMEOUT_MS);
	const runId = crypto.randomUUID();
	const billingRequestId = `${CHAT_BILLING_PREFIX}${crypto.randomUUID()}`;
	const claimed = await db
		.update(aiConversation)
		.set({ activeRunId: runId, activeRunExpiresAt: expiresAt })
		.where(
			and(
				eq(aiConversation.id, conv.id),
				eq(aiConversation.userId, userId),
				sql`${aiConversation.activeRunId} IS NULL`,
			),
		)
		.returning({ id: aiConversation.id });
	if (claimed.length === 0) {
		const raced = await findSettledRunBySendId(userId, input.sendId);
		if (raced) return replayRunResult(userId, raced);
		throw new ConflictError(CONVERSATION_BUSY_MESSAGE);
	}
	try {
		await db.insert(aiChatRun).values({
			id: runId,
			conversationId: conv.id,
			userId,
			sendId: input.sendId,
			status: "running",
			question: target.question,
			userSequence: target.userSequence,
			modelKey,
			modelId: model.id,
			promptName: REGION_QA_SYSTEM_PROMPT.name,
			promptVersion: managedPrompt.ref?.version ?? null,
			promptSource: managedPrompt.source,
			billingRequestId,
			expiresAt,
		});
	} catch (e) {
		await releaseActiveRun(userId, conv.id, runId);
		const raced = await findSettledRunBySendId(userId, input.sendId);
		if (raced) return replayRunResult(userId, raced);
		throw e;
	}

	const begun = await beginMeteredInference(userId, {
		estimate,
		requestId: billingRequestId,
		logBase,
	});
	if (begun.blocked) {
		await db
			.update(aiChatRun)
			.set({ status: "blocked", finishedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(aiChatRun.id, runId), eq(aiChatRun.status, "running")));
		await releaseActiveRun(userId, conv.id, runId);
		return {
			status: "blocked",
			conversationId: conv.id,
			runId,
			balance: begun.balance,
			required: begun.required,
		};
	}
	await db
		.update(aiChatRun)
		.set({
			reservedCredits: begun.reservation.reservedCredits,
			reservedMicroUsd: begun.reservation.reservedMicroUsd,
		})
		.where(eq(aiChatRun.id, runId));

	try {
		const done = await finishMeteredInference(
			userId,
			{ reservation: begun.reservation, logBase },
			async (ctx) => {
				const [alive] = await db
					.select({ status: aiChatRun.status, expiresAt: aiChatRun.expiresAt })
					.from(aiChatRun)
					.where(eq(aiChatRun.id, runId))
					.limit(1);
				if (!isRunAlive(alive)) {
					throw new ConflictError(
						"生成の有効期限が切れました。再試行してください。",
					);
				}
				const out = await runRegionQaTurn(
					{ apiKey, modelKey, model, messages, managedPrompt },
					ctx,
				);
				await persistChatSuccess({
					userId,
					conversationId: conv.id,
					runId,
					answer: out.value,
					charge: out.charge,
				});
				return out;
			},
		);
		return {
			status: "ok",
			conversationId: conv.id,
			runId,
			answer: done.value,
			actualTokens: done.charge.tokens,
			balance: done.balance,
		};
	} catch (e) {
		const kind = toErrorKind(e);
		// 期限切れの遅延完了(conflict)は状態を上書きしない(中断への遷移を優先する)。
		// set に undefined を渡すと列の扱いが不定になるため、オブジェクトを作り分ける。
		const failedPatch =
			kind === "conflict"
				? { errorKind: kind, finishedAt: new Date(), updatedAt: new Date() }
				: {
						status: "failed" as const,
						errorKind: kind,
						finishedAt: new Date(),
						updatedAt: new Date(),
					};
		await db
			.update(aiChatRun)
			.set(failedPatch)
			.where(and(eq(aiChatRun.id, runId), eq(aiChatRun.status, "running")));
		await releaseActiveRun(userId, conv.id, runId);
		if (e instanceof ConflictError) throw e;
		if (e instanceof HttpError) throw e;
		logWarn("ai chat retry failed", {
			userId,
			conversationId: conv.id,
			runId,
		});
		throw new HttpError(500, toUserErrorMessage(kind));
	}
}
