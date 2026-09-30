/**
 * 生の better-auth admin エンドポイント(HTTP ingress)の単一情報源(#543)。
 *
 * better-auth の admin プラグインは自前の HTTP ルート(`/api/auth/admin/*`)を登録し、
 * `src/routes/api/auth/$.ts` の catch-all がそれを丸ごと `auth.handler` へ転送する。
 * アプリの管理操作は `src/server/admin.ts` の server function 経由でしか監査
 * (`admin_audit_log`)と理由必須が掛からないため、この素通りの経路からだと
 * set-role での昇格も set-user-password での乗っ取りも記録に残らない。
 *
 * 対策は「アプリが UI から呼んでいない生エンドポイントを HTTP 入口で塞ぐ」(Issue の
 * 案A)。`hooks.before`(`src/lib/auth.ts`)では塞がない。あちらは HTTP とサーバ内の
 * `auth.api.*` 直接呼び出しの両方を通すパイプラインなので、塞ぐと監査付きの正規経路
 * (`admin-actions.ts` の banUser / revokeSessions / impersonate 等)まで壊れる。
 * HTTP 入口だけを塞げば、内部呼び出しは HTTP を経由しないので影響を受けない。
 *
 * このモジュールはサーバ専用の import を持たない純粋な判定だけに保ち、
 * jsdom 単体テストから直接検証できるようにする(`impersonation.ts` と同じ方針)。
 * 実際の転送判断(`$.ts`)と回帰テスト(workers)はここを通す。判定を経路ごとに書くと
 * 後から足した経路で必ず漏れるため、この1関数が唯一の関門。
 */

/**
 * 昇格・乗っ取り等の実害がある生 admin エンドポイントの列挙。
 * better-auth の `ctx.path` 形式(`/api/auth` 接頭辞なし)で書く。
 * `ADMIN_AUDIT_ACTIONS`(`audit.ts`)と同じ as-const パターンで、テストが
 * 「列挙したすべてが関門を通る」ことを機械的に固定する。
 *
 * better-auth のバージョンで surface が変わりうるため、網羅の正は
 * `node_modules/better-auth/dist/plugins/admin/routes.mjs` の
 * `createAuthEndpoint("/admin/...")` の一覧と照合すること。
 */
export const RAW_ADMIN_AUTH_ENDPOINTS = [
	"/admin/set-role",
	"/admin/set-user-password",
	"/admin/remove-user",
	"/admin/create-user",
	"/admin/update-user",
	"/admin/impersonate-user",
	"/admin/stop-impersonating",
	"/admin/ban-user",
	"/admin/unban-user",
	"/admin/revoke-user-session",
	"/admin/revoke-user-sessions",
	"/admin/list-users",
	"/admin/list-user-sessions",
	"/admin/get-user",
	"/admin/has-permission",
] as const;

/**
 * better-auth のエンドポイントパスが「塞ぐべき生 admin エンドポイント」かどうか。
 *
 * 個別列挙ではなく `/admin/` 接頭辞で deny-by-default にする。将来 better-auth が
 * admin 配下にエンドポイントを足しても、既定で拒否側へ倒すため。
 * UI が生の `/api/auth/admin/*` を HTTP で呼ぶことは無い(全管理操作は
 * `src/server/admin.ts` → `auth.api.*` 直接呼び出し)ので、許可パスは持たない。
 */
export function isBlockedAdminAuthPath(authPath: string): boolean {
	return authPath === "/admin" || authPath.startsWith("/admin/");
}

/**
 * HTTP リクエストが塞ぐべき生 admin エンドポイント宛てなら 403 レスポンスを返し、
 * そうでなければ null を返す。`$.ts` の catch-all が `auth.handler` へ渡す前に呼ぶ。
 *
 * 純粋(`URL`/`Response` のみを使い、サーバ専用 import を持たない)なので jsdom と
 * workers のどちらのテストからも直接叩ける。
 */
export function blockedAdminAuthResponse(request: Request): Response | null {
	const pathname = new URL(request.url).pathname;
	const prefix = "/api/auth";
	const authPath = pathname.startsWith(prefix)
		? pathname.slice(prefix.length) || "/"
		: pathname;
	if (!isBlockedAdminAuthPath(authPath)) return null;
	return Response.json(
		{
			message:
				"このエンドポイントは無効化されています。管理操作は管理画面から行ってください。",
		},
		{ status: 403 },
	);
}
