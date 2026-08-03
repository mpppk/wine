import { isAdminSession } from "#/lib/admin/guard";
import type { auth } from "#/lib/auth";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * ルートの `beforeLoad` がコンテキストに載せてよいセッション情報。**生の better-auth
 * セッションをそのままクライアントへ渡さないための境界型**(#388)。
 *
 * TanStack Start は `beforeLoad` の戻り値(route context)を SSR 時に dehydrate して
 * HTML 内の script に埋め込み、クライアント遷移時も server function のレスポンスとして
 * ブラウザへ返す。`auth.api.getSession()` の戻り値には `session.token`(生のセッション
 * トークン)・`session.ipAddress`・`session.userAgent` が含まれるため、そのまま返すと
 * httpOnly Cookie で DOM から隔離しているはずのシークレットが、注入スクリプト・
 * ブラウザ拡張・保存ページ/HAR の共有から読める状態になる。
 *
 * ここに**足してよいのは「クライアントに見えて構わない」フィールドだけ**。UI の分岐に
 * 必要になったからといって生セッションを返す形に戻さないこと。
 */
export interface RouteSession {
	/** 自分自身のユーザID。 */
	userId: string;
	/** 表示名。未設定なら null。 */
	userName: string | null;
	/**
	 * 管理者か。判定は `isAdminSession`(server function 境界の `adminMiddleware` と
	 * 共有する SSOT)に委ね、`role`/`banned` そのものはクライアントへ出さない。
	 */
	isAdmin: boolean;
}

/**
 * 生セッションを route context 用の最小表現へ落とす。未ログインは null。
 *
 * `getRouteSession`(server function)が唯一の呼び出し元だが、純関数として切り出して
 * 「何が漏れないか」を単体テストで固定できるようにしてある(route-session.test.ts)。
 */
export function toRouteSession(session: Session): RouteSession | null {
	if (!session) return null;
	return {
		userId: session.user.id,
		userName: session.user.name ?? null,
		isAdmin: isAdminSession(session),
	};
}
