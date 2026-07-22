import type { auth } from "#/lib/auth";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * 管理ガードの単一情報源(#161)。role==="admin" かつ BAN されていないセッションのみ
 * 管理者とみなす。`adminMiddleware`(server function 境界)とルートの `beforeLoad`
 * (`requireAdminBeforeLoad`)の双方がこれを使い、判定条件のドリフト(片方だけ banned を
 * 見落とす等)を防ぐ。
 *
 * このモジュールはサーバ専用の import を持たない純関数として保ち、jsdom 単体テストから
 * 直接検証できるようにする(getSession 等を使う beforeLoad は route-guard.ts に置く)。
 */
export function isAdminSession(
	session: Session,
): session is NonNullable<Session> {
	return (
		session != null && session.user.role === "admin" && !session.user.banned
	);
}
