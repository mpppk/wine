import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";

export const authMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) {
			throw new Error("Unauthorized");
		}
		return next({ context: { user: session.user, session: session.session } });
	},
);

/** 管理者(role="admin")限定ミドルウェア。非管理者・BAN中は未ログインと同じ挙動で拒否する */
export const adminMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		if (session?.user.role !== "admin" || session.user.banned) {
			throw new Error("Unauthorized");
		}
		return next({ context: { user: session.user, session: session.session } });
	},
);

/** ログイン任意のミドルウェア。未ログインなら user: null を注入する */
export const optionalAuthMiddleware = createMiddleware({
	type: "function",
}).server(async ({ next }) => {
	const request = getRequest();
	const session = await auth.api.getSession({ headers: request.headers });
	return next({ context: { user: session?.user ?? null } });
});
