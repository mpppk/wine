import { redirect } from "@tanstack/react-router";
import type { RouteSession } from "#/lib/route-session";
import { getRouteSession } from "#/server/auth";

/**
 * 認証必須ルートの `beforeLoad` 共通処理(#259)。未ログインなら /login へ戻し、
 * ログイン済みなら route context 用の最小セッション(`RouteSession`)を返す。
 * cellar 系4ルートと profile が同一の beforeLoad をコピーしていたのを集約したもの。
 *
 * 「ログイン後に元のページへ戻す」(redirect search の付与)のような仕様追加は
 * ここに入れれば認証必須ルート全体に効く。管理ルートも
 * `requireAdminBeforeLoad`(lib/admin/route-guard.ts)経由でここを通るため、
 * 一般ガードと管理ガードで未ログイン時の挙動がドリフトしない(#161/#177)。
 *
 * **戻り値は route context として SSR HTML とクライアントへ露出する**。生セッションを
 * 返していた頃はセッショントークン・IP・UA が直列化されていた(#388)。UI が新しい
 * フィールドを必要としたら、生セッションに戻すのではなく `RouteSession` に足す。
 */
export async function requireAuthBeforeLoad(): Promise<RouteSession> {
	const session = await getRouteSession();
	if (!session) {
		throw redirect({ to: "/login" });
	}
	return session;
}
