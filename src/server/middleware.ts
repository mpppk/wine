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
