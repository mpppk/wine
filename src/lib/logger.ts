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

/** ネストを辿る深さの上限。これを超えたら畳んで打ち切る(肥大化・病的な入れ子の防止)。 */
const MAX_FIELD_DEPTH = 4;

/** 素のオブジェクト(リテラル/`Object.create(null)`)か。Date や Map 等は対象外。 */
function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * フィールド値を直列化可能な形へ畳む。**ネストした Error も文字列化する**のが要点(#331)。
 *
 * `JSON.stringify` は Error の `message` / `stack` が非 enumerable なため `{}` に潰す。
 * フィールド直下しか変換していなかった頃は、better-auth のロガーブリッジのように
 * 可変長 `args` を配列で渡す経路の真因が丸ごと消えていた
 * (`{"msg":"better-auth: Error","args":[{}]}`)。変換を呼び出し側ごとに書くと後から
 * 足した経路で必ず漏れるため、全ログが通るこの1箇所で畳む。
 *
 * 再帰するのは配列と素のオブジェクトだけ。Date のように `toJSON` で意味のある文字列に
 * なる値を作り直すと `{}` に落ちてしまうため、そのまま `JSON.stringify` に渡す。
 * 循環参照は訪問済み集合で止める(ログ呼び出し自体を例外にしない)。
 */
function sanitize(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
): unknown {
	if (value instanceof Error) return errToString(value);
	if (value === null || typeof value !== "object") return value;
	const obj = value as object;
	if (seen.has(obj)) return "[circular]";
	if (!Array.isArray(value) && !isPlainObject(obj)) return value;
	if (depth >= MAX_FIELD_DEPTH) return "[truncated]";
	seen.add(obj);
	try {
		if (Array.isArray(value)) {
			return value.map((v) => sanitize(v, depth + 1, seen));
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			out[k] = sanitize(v, depth + 1, seen);
		}
		return out;
	} finally {
		// 兄弟に同じオブジェクトが現れるのは循環ではないので、抜けるときに外す。
		seen.delete(obj);
	}
}

function emit(
	level: "error" | "warn" | "info",
	msg: string,
	fields: LogFields,
) {
	const safe: LogFields = {};
	const seen = new WeakSet<object>();
	for (const [key, value] of Object.entries(fields)) {
		safe[key] = sanitize(value, 0, seen);
	}
	// 直列化不能な値(BigInt・throw する toJSON 等)でログ呼び出し自体を例外にしない。
	// ログはリクエスト処理の失敗パスから呼ばれるので、ここで throw すると元の失敗を
	// 覆い隠す新たな例外に化ける(#331)。最低限 msg は必ず出す。
	let line: string;
	try {
		line = JSON.stringify({ level, msg, ...safe });
	} catch (e) {
		line = JSON.stringify({
			level,
			msg,
			logSerializationError: errToString(e),
		});
	}
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
