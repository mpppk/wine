import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { isAdminSession } from "#/lib/admin/guard";
import { auth } from "#/lib/auth";
import { ForbiddenError, HttpError, UnauthorizedError } from "#/lib/errors";
import { logError } from "#/lib/logger";

// server function が throw すると既定では HTTP 500 になる。認証切れ(正常系)や
// クライアント入力エラー(4xx相当)まで 5xx に混ざると、Workers のメトリクス上で
// 実際の障害シグナルが希釈され、クライアントもステータスで種別を判別できない。
// そこで認証失敗は 401/403 を明示し、ハンドラ(サービス層)が投げる HttpError も
// この境界で対応するステータスへ写す。
//
// 加えて、HttpError 以外(=想定外の 5xx)はこの1箇所で構造化ログに残す。全 server
// function がこのミドルウェアを通るため、新機能(billing/credit/ai 等)の想定外失敗も
// 呼び出し側に手を入れず userId 付きで Workers Logs から追跡できる(#156)。
async function runWithHttpStatus<T>(
	next: () => Promise<T> | T,
	ctx?: { userId?: string },
): Promise<T> {
	try {
		return await next();
	} catch (e) {
		if (e instanceof HttpError) {
			// 想定内の 4xx。ステータスだけ写してログは出さない(障害シグナルを薄めない)。
			setResponseStatus(e.status);
		} else {
			logError("server fn failed", { userId: ctx?.userId, err: e });
		}
		throw e;
	}
}

export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) {
			setResponseStatus(401);
			throw new UnauthorizedError();
		}
		return runWithHttpStatus(
			() => next({ context: { user: session.user, session: session.session } }),
			{ userId: session.user.id },
		);
	},
);

/** 管理者(role="admin")限定ミドルウェア。非管理者・BAN中は 403 で拒否する */
export const adminMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		// role==="admin" かつ !banned の単一情報源(ルートの beforeLoad と共有)。
		if (!isAdminSession(session)) {
			setResponseStatus(403);
			throw new ForbiddenError();
		}
		return runWithHttpStatus(
			() => next({ context: { user: session.user, session: session.session } }),
			{ userId: session.user.id },
		);
	},
);

/** ログイン任意のミドルウェア。未ログインなら user: null を注入する */
export const optionalAuthMiddleware = createMiddleware({
	type: "function",
}).server(async ({ next }) => {
	const request = getRequest();
	const session = await auth.api.getSession({ headers: request.headers });
	// 未ログインでも通すが、ハンドラが入力検証で投げる HttpError(400等)は
	// 適切なステータスへ写す。
	return runWithHttpStatus(
		() => next({ context: { user: session?.user ?? null } }),
		{ userId: session?.user?.id },
	);
});
