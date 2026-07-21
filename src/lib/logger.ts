// サーバ側の構造化1行ログ。Workers Logs は1行のJSON文字列を構造化検索できるため、
// メッセージと任意のコンテキスト(userId / op / err 等)を1つのJSONにまとめて出力する。
// server functions・サービス層・API ルート・MCP の失敗パスから呼ぶ。
// クライアント(ブラウザ)では使わない — クライアントは従来どおり console.* を使う。

type LogFields = Record<string, unknown>;

/** Error はメッセージ+名前に畳んで記録する(生スタックは肥大化するため出さない)。 */
export function errToString(e: unknown): string {
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
