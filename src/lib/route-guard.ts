import { redirect } from "@tanstack/react-router";
import type { auth } from "#/lib/auth";
import { getSession } from "#/server/auth";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * 認証必須ルートの `beforeLoad` 共通処理(#259)。未ログインなら /login へ戻し、
 * ログイン済みならそのセッションを返す。cellar 系4ルートと profile が同一の
 * beforeLoad をコピーしていたのを集約したもの。
 *
 * 「ログイン後に元のページへ戻す」(redirect search の付与)のような仕様追加は
 * ここに入れれば認証必須ルート全体に効く。管理ルートも
 * `requireAdminBeforeLoad`(lib/admin/route-guard.ts)経由でここを通るため、
 * 一般ガードと管理ガードで未ログイン時の挙動がドリフトしない(#161/#177)。
 */
export async function requireAuthBeforeLoad(): Promise<NonNullable<Session>> {
	const session = await getSession();
	if (!session) {
		throw redirect({ to: "/login" });
	}
	return session;
}
