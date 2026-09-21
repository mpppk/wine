import { AI_MAX_HISTORY_MESSAGES, AI_MAX_QUESTION_CHARS } from "./config";
import type { ChatMessage } from "./region-qa";

// 地域Q&Aの会話永続化(Issue #603)の純ロジック。DB/env 非依存で単体テスト可能にする。
// 数値のSSOTはここに置き、zod スキーマ・サービス層・UI の全員が同じ定数を import する。

/** 試行の状態。DB の ai_chat_run.status と1対1。 */
export const CHAT_RUN_STATUSES = [
	"running",
	"succeeded",
	"failed",
	"blocked",
	"interrupted",
] as const;

export type ChatRunStatus = (typeof CHAT_RUN_STATUSES)[number];

/** 終端状態か(= その試行がそれ以上遷移しないか)。 */
export function isTerminalChatRunStatus(status: ChatRunStatus): boolean {
	return status !== "running";
}

/** 明示的な再試行の対象になる状態か(成功した試行の再実行は無い)。 */
export function isRetryableChatRunStatus(status: ChatRunStatus): boolean {
	return (
		status === "failed" || status === "blocked" || status === "interrupted"
	);
}

/**
 * 試行の実行期限(ms)。Worker中断で残った running を中断へ遷移させるまでの時間。
 *
 * credit-service の `ORPHAN_GRACE_MS`(10分)と**同じ値**にする。期限切れの決着は
 * クレジットを返さない(回収は `reclaimOrphanReservations` に一本化する)ので、
 * 決着した時点でその予約が既に回収の対象年齢に達している必要がある。短くすると
 * 「runは中断表示なのに予約はまだ猶予期間内で残高が戻らない」窓ができる。
 */
export const AI_CHAT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** 会話タイトルの最大文字数。最初の質問の先頭切り出し(LLM不使用)。 */
export const CHAT_TITLE_MAX_CHARS = 40;

/**
 * 保存履歴の1回取得あたりの上限(会話の取得・再開用)。
 *
 * LLMへ渡す履歴の上限(AI_MAX_HISTORY_MESSAGES)とは**別の軸**。保存はユーザの
 * 会話の全体像、LLM投入は直近の往復だけを見る。長い会話を開いても全件送信や
 * 無制限な原価増加が起きないよう、投入側は clampHistory で切り詰める。
 */
export const CHAT_SAVED_HISTORY_PAGE_SIZE = 50;

/** 履歴一覧の1回取得あたりの上限。 */
export const CHAT_LIST_PAGE_SIZE = 20;

/** 履歴一覧の上限の最大値(クライアント指定の暴走を抑える)。 */
export const CHAT_LIST_MAX_PAGE_SIZE = 50;

/** 送信IDの最大文字数(クライアント採番のUUIDを想定)。 */
export const CHAT_SEND_ID_MAX_CHARS = 80;

/** 失敗時の利用者向けの種別。詳細(モデル都合の例外)はサーバ側のログにだけ残す。 */
export const CHAT_RUN_ERROR_KINDS = ["llm", "conflict", "persistence"] as const;

export type ChatRunErrorKind = (typeof CHAT_RUN_ERROR_KINDS)[number];

/** DBの値を安全な種別へ絞る。未知値は null(詳細はサーバログのみに残す規律のため)。 */
export function toChatRunErrorKind(value: unknown): ChatRunErrorKind | null {
	if (typeof value !== "string") return null;
	return (CHAT_RUN_ERROR_KINDS as readonly string[]).includes(value)
		? (value as ChatRunErrorKind)
		: null;
}

/**
 * 会話タイトルを最初の質問から切り出す。タイトル生成のためのLLM呼び出しは行わない。
 * 空白の正規化だけを行い、意味の切り詰めはしない。
 */
export function buildChatTitle(question: string): string {
	const normalized = question.trim().replace(/\s+/g, " ");
	if (normalized.length <= CHAT_TITLE_MAX_CHARS) return normalized;
	return `${normalized.slice(0, CHAT_TITLE_MAX_CHARS)}…`;
}

/** 保存済みメッセージの読み取り形。 */
export interface SavedChatMessage {
	role: "user" | "assistant";
	content: string;
	sequence: number;
	/** この発言を生んだ試行。失敗試行の assistant 発言の除外に使う */
	runId: string | null;
	/** 発言を生んだ試行の状態。NULL run(旧データ互換)は成功扱い */
	runStatus: ChatRunStatus | null;
}

/**
 * 保存済み履歴から完了した往復だけを残す(クランプ無し)。
 *
 * - 成功した試行の往復だけを残す。失敗/未完了の試行の assistant 発言と、
 *   保存後に捏造された可能性のある未関連付けの assistant 発言は入れない
 * - ユーザ自身の発言は試行の成否によらず残す(利用者が実際に入力した文脈のため)
 */
export function filterCompletedMessages(
	messages: SavedChatMessage[],
): ChatMessage[] {
	const kept: ChatMessage[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			kept.push({ role: "user", content: m.content });
			continue;
		}
		// assistant 発言は成功した試行に紐づくものだけ。run不明(NULL)は
		// 旧データ互換として残すが、新規書き込みは必ず runId を持つ。
		if (m.runId === null || m.runStatus === "succeeded") {
			kept.push({ role: "assistant", content: m.content });
		}
	}
	return kept;
}

/**
 * 保存済み履歴からLLMへ渡す履歴を選ぶ。
 *
 * `filterCompletedMessages` に加え、直近 AI_MAX_HISTORY_MESSAGES 件に切り詰める
 * (古い順に落とす)。保存履歴の全体像とLLM投入の上限を混同しない。
 */
export function selectLlmHistory(messages: SavedChatMessage[]): ChatMessage[] {
	const kept = filterCompletedMessages(messages);
	if (kept.length <= AI_MAX_HISTORY_MESSAGES) return kept;
	return kept.slice(kept.length - AI_MAX_HISTORY_MESSAGES);
}

/** 質問文の検証(サービス層の防御。境界の zod と同じ上限を見る)。 */
export function validateChatQuestion(question: string): string | null {
	const trimmed = question.trim();
	if (trimmed.length === 0) return "質問を入力してください。";
	if (trimmed.length > AI_MAX_QUESTION_CHARS)
		return `質問は${AI_MAX_QUESTION_CHARS}文字以内で入力してください。`;
	return null;
}

/** 送信IDの検証(サービス層の防御。境界の zod と同じ上限を見る)。 */
export function validateChatSendId(sendId: string): string | null {
	if (sendId.length === 0) return "送信IDを指定してください。";
	if (sendId.length > CHAT_SEND_ID_MAX_CHARS) return "送信IDが長すぎます。";
	return null;
}
