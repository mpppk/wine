import { auth } from "#/lib/auth";
import { logWarn } from "#/lib/logger";
import { blockedAdminAuthResponse } from "./blocked-auth-paths";

/**
 * `/api/auth/*` の HTTP 入口の実体(#543)。
 * `src/routes/api/auth/$.ts` の catch-all(GET/POST 両方)と workers 回帰テストが
 * この1関数を通す。生 admin エンドポイントの塞ぎ判定は `blocked-auth-paths.ts`
 * に寄せ、ここでの分岐は「塞ぐ/転送」の2択だけにする。
 *
 * アプリの管理操作(`src/server/admin.ts` → `auth.api.*` 直接呼び出し)は HTTP を
 * 経由しないため、この関門の影響を受けない。
 */
export function handleAuthRequest(
	request: Request,
): Response | Promise<Response> {
	const blocked = blockedAdminAuthResponse(request);
	if (!blocked) return auth.handler(request);
	logWarn("blocked raw admin auth endpoint", {
		path: new URL(request.url).pathname,
		method: request.method,
	});
	return blocked;
}
