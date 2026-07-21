import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";
import { ForbiddenError, HttpError, UnauthorizedError } from "#/lib/errors";

// server function が throw すると既定では HTTP 500 になる。認証切れ(正常系)や
// クライアント入力エラー(4xx相当)まで 5xx に混ざると、Workers のメトリクス上で
// 実際の障害シグナルが希釈され、クライアントもステータスで種別を判別できない。
// そこで認証失敗は 401/403 を明示し、ハンドラ(サービス層)が投げる HttpError も
// この境界で対応するステータスへ写す。
async function runWithHttpStatus<T>(next: () => Promise<T> | T): Promise<T> {
	try {
		return await next();
	} catch (e) {
		if (e instanceof HttpError) {
			setResponseStatus(e.status);
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
		return runWithHttpStatus(() =>
			next({ context: { user: session.user, session: session.session } }),
		);
	},
);

/** 管理者(role="admin")限定ミドルウェア。非管理者・BAN中は 403 で拒否する */
export const adminMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		if (session?.user.role !== "admin" || session.user.banned) {
			setResponseStatus(403);
			throw new ForbiddenError();
		}
		return runWithHttpStatus(() =>
			next({ context: { user: session.user, session: session.session } }),
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
	return runWithHttpStatus(() =>
		next({ context: { user: session?.user ?? null } }),
	);
});
