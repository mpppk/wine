import { createFileRoute } from "@tanstack/react-router";
import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "#/lib/auth";

// RFC 8414 discovery. MCP clients resolve the authorization server from the
// origin, so this must live at the site root (outside the /api/auth basePath).
export const Route = createFileRoute("/.well-known/oauth-authorization-server")(
	{
		server: {
			handlers: {
				GET: ({ request }) => oAuthDiscoveryMetadata(auth)(request),
			},
		},
	},
);
