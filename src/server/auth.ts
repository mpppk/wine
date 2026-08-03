import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";
import { type RouteSession, toRouteSession } from "#/lib/route-session";

/**
 * ルートの `beforeLoad` からセッションを引く唯一の入口。**生のセッションではなく
 * `RouteSession`(クライアントに見せてよい最小表現)を返す**(#388)。
 *
 * この server function の戻り値は、SSR では route context として HTML 内の script に
 * dehydrate され、クライアント遷移では `/_serverFn/*` のレスポンスとしてブラウザへ届く。
 * つまり**ここから出たものは必ずクライアントに露出する**。以前は
 * `auth.api.getSession()` の戻り値をそのまま返しており、`session.token`(生のセッション
 * トークン)・`ipAddress`・`userAgent` が両経路で漏れていた。
 *
 * サーバ側の認可判定はここを通さない。server function 境界は `src/server/middleware.ts`
 * が `auth.api.getSession()` を直に呼び、生セッションで判定する(そちらの結果はクライアントへ
 * 返らない)。**認可の判断材料をこの戻り値から取らないこと**。
 */
export const getRouteSession = createServerFn({ method: "GET" }).handler(
	async (): Promise<RouteSession | null> => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		return toRouteSession(session);
	},
);
