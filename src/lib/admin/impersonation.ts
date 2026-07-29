import type { auth } from "#/lib/auth";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * なりすまし(impersonation)の判定と「閲覧専用」制約の単一情報源(#116)。
 *
 * 管理者が対象ユーザのセッションを一時的に借りる機能なので、なりすまし中の書き込みは
 * すべて**対象ユーザ本人の実データ**に落ちる(クイズ成績・セラー・AIクレジット消費)。
 * 後から「本人の操作」と「管理者の操作」を切り分ける手段が無いため、なりすまし中は
 * 書き込みを一切通さない。
 *
 * 判定を経路ごとに書くと後から足した経路で必ず漏れる(CLAUDE.md「横断的な防御・規約は
 * 共通チョークポイントに寄せる」)。そこで判定はこのモジュールに閉じ、
 * `src/server/middleware.ts`(server function 境界)と `requireApiSession`
 * (FormData を受ける API ルート境界)の2箇所だけがこれを呼ぶ。
 *
 * このモジュールは `guard.ts` と同様サーバ専用の import を持たない純関数として保ち、
 * jsdom 単体テストから直接検証できるようにする。
 */

/** なりすまし中に書き込みを拒否したときのメッセージ(UI・APIで共有)。 */
export const IMPERSONATION_READONLY_MESSAGE =
	"なりすまし中は閲覧のみ可能です。この操作は実行できません。";

/** セッションがなりすまし(管理者が対象ユーザとして発行したもの)かどうか。 */
export function isImpersonatedSession(session: Session): boolean {
	return session?.session.impersonatedBy != null;
}

/**
 * 書き込みリクエストとみなすかどうか。GET/HEAD 以外はすべて書き込み扱いにする
 * (server function は `createServerFn({ method })` がそのまま HTTP メソッドになる)。
 * 「安全なメソッドを列挙して残りを拒否」の向きにしているのは、新しいメソッドが
 * 増えたときに既定で拒否側へ倒すため。
 */
export function isWriteRequest(method: string): boolean {
	const normalized = method.toUpperCase();
	return normalized !== "GET" && normalized !== "HEAD";
}

/** なりすまし中の書き込みとして拒否すべきリクエストかどうか。 */
export function isImpersonationWriteBlocked(
	session: Session,
	method: string,
): boolean {
	return isImpersonatedSession(session) && isWriteRequest(method);
}
