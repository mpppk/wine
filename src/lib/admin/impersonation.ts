/**
 * なりすまし(impersonation)の判定と「閲覧専用」制約の単一情報源(#116)。
 *
 * 管理者が対象ユーザのセッションを一時的に借りる機能なので、なりすまし中の書き込みは
 * すべて**対象ユーザ本人の実データ**に落ちる(クイズ成績・セラー・AIクレジット消費・
 * Stripe サブスク)。後から「本人の操作」と「管理者の操作」を切り分ける手段が無いため、
 * なりすまし中は書き込みを一切通さない。
 *
 * 判定を経路ごとに書くと後から足した経路で必ず漏れる(CLAUDE.md「横断的な防御・規約は
 * 共通チョークポイントに寄せる」)。そこで判定はこのモジュールに閉じ、
 * docs/architecture.md の「サーバーへの入口」すべてがここを通る:
 *
 *  1. server function — `src/server/middleware.ts` の3ミドルウェア
 *  2. API ルート(FormData) — `#/lib/images/form-api.ts` の `requireApiSession`
 *  3. better-auth 自身のエンドポイント — `src/lib/auth.ts` の `hooks.before`
 *
 * 3 は `authClient.updateUser` / `subscription.*` / `delete-user` の実体で、1・2 の
 * どちらも通らない。ここを塞がないと「閲覧専用」は名ばかりになる。
 *
 * このモジュールは `guard.ts` と同様サーバ専用の import を持たない純関数として保ち、
 * jsdom 単体テストから直接検証できるようにする。セッションは経路ごとに型が違うため、
 * 判定に要る形だけを構造的に受ける(`#/lib/auth` への型依存を作らない)。
 */

/**
 * なりすまし判定に必要な最小の形。`impersonatedBy` 以外の項目は経路ごとに異なるので、
 * `Record<string, unknown>` を交差させて任意の追加項目を受ける(これが無いと TS の
 * weak type detection が「共通プロパティが無い」として実セッションを弾く)。
 */
type MaybeImpersonatedSession =
	| {
			session?:
				| ({ impersonatedBy?: string | null } & Record<string, unknown>)
				| null;
	  }
	| null
	| undefined;

/** なりすまし中に書き込みを拒否したときのメッセージ(UI・APIで共有)。 */
export const IMPERSONATION_READONLY_MESSAGE =
	"なりすまし中は閲覧のみ可能です。この操作は実行できません。";

/** セッションがなりすまし(管理者が対象ユーザとして発行したもの)かどうか。 */
export function isImpersonatedSession(
	session: MaybeImpersonatedSession,
): boolean {
	return session?.session?.impersonatedBy != null;
}

/**
 * なりすまし中でも通す better-auth のエンドポイント。
 *
 * - `/admin/stop-impersonating`: なりすましの終了。これを塞ぐと管理者が戻れない。
 * - `/sign-out`: なりすましセッション自身を捨てるだけで、対象ユーザのデータにも
 *   本人の他セッションにも影響しない。閉じ込めを避けるため許可する。
 */
const IMPERSONATION_ALLOWED_AUTH_PATHS: ReadonlySet<string> = new Set([
	"/admin/stop-impersonating",
	"/sign-out",
]);

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
	session: MaybeImpersonatedSession,
	method: string,
): boolean {
	return isImpersonatedSession(session) && isWriteRequest(method);
}

/**
 * better-auth のエンドポイントで、なりすまし判定のためにセッションを引く必要が
 * あるかどうか(#116)。メソッドと許可パスだけで「通す」と決まる大多数のリクエストで
 * 余計なセッション参照をしないための前段。
 */
export function needsImpersonationCheck(method: string, path: string): boolean {
	if (IMPERSONATION_ALLOWED_AUTH_PATHS.has(path)) return false;
	return isWriteRequest(method);
}
