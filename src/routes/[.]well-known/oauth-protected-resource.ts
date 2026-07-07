import { createFileRoute } from "@tanstack/react-router";
import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "#/lib/auth";

// RFC 9728 protected resource metadata, referenced by the 401
// WWW-Authenticate header returned from /api/mcp.
export const Route = createFileRoute("/.well-known/oauth-protected-resource")({
	server: {
		handlers: {
			GET: ({ request }) => oAuthProtectedResourceMetadata(auth)(request),
		},
	},
});
