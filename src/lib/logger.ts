// サーバ側の構造化1行ログ。Workers Logs は1行のJSON文字列を構造化検索できるため、
// メッセージと任意のコンテキスト(userId / op / err 等)を1つのJSONにまとめて出力する。
// server functions・サービス層・API ルート・MCP の失敗パスから呼ぶ。
// クライアント(ブラウザ)では使わない — クライアントは従来どおり console.* を使う。

export type LogFields = Record<string, unknown>;

/** 辿る cause の最大数(= 1行に載る要素は最大 MAX_CAUSE_LINKS + 1 個)。
 *  多段ラップでログ行が肥大化しないよう抑える。 */
const MAX_CAUSE_LINKS = 3;

/**
 * Error はメッセージ+名前に畳んで記録する(生スタックは肥大化するため出さない)。
 *
 * `cause` があれば ` <- ` で連結する(#271)。ラップした例外は外側が「何に失敗したか」、
 * cause が「なぜ失敗したか」を持つため、cause を落とすと真因が消える。実際
 * `ai-service` は全滅時の原因追跡のために最後の失敗要因を cause に積んでいるが(#156)、
 * 受け側が捨てていたので設計意図が無効化されていた。
 *
 * 辿るのは MAX_CAUSE_LINKS 段まで。打ち切ったときは末尾に `…` を付けて「まだ続きが
 * ある」ことを示す。同じ Error を指す循環(`e.cause === e` 等)も訪問済み集合で止める。
 */
export function errToString(e: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = e;
	while (current != null && !seen.has(current)) {
		seen.add(current);
		parts.push(formatOne(current));
		const next = current instanceof Error ? current.cause : undefined;
		if (next === undefined) break;
		if (parts.length > MAX_CAUSE_LINKS) {
			parts.push("…");
			break;
		}
		current = next;
	}
	return parts.join(" <- ");
}

/** cause を辿らずに1つの値を1行へ畳む。 */
function formatOne(e: unknown): string {
	if (e instanceof Error) {
		return e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message;
	}
	return String(e);
}

function emit(
	level: "error" | "warn" | "info",
	msg: string,
	fields: LogFields,
) {
	// フィールド内の Error 値は文字列化してから直列化する(JSON.stringify は Error を
	// {} に落とすため)。
	const safe: LogFields = {};
	for (const [key, value] of Object.entries(fields)) {
		safe[key] = value instanceof Error ? errToString(value) : value;
	}
	const line = JSON.stringify({ level, msg, ...safe });
	if (level === "error") {
		console.error(line);
	} else if (level === "warn") {
		console.warn(line);
	} else {
		console.info(line);
	}
}

/** エラー(予期しない失敗)。err フィールドには捕捉した例外を渡してよい。 */
export function logError(msg: string, fields: LogFields = {}): void {
	emit("error", msg, fields);
}

/** 警告(想定内だが注視したい事象)。 */
export function logWarn(msg: string, fields: LogFields = {}): void {
	emit("warn", msg, fields);
}

/** 情報(監査・トレース)。 */
export function logInfo(msg: string, fields: LogFields = {}): void {
	emit("info", msg, fields);
}
