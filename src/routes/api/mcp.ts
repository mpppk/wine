import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFileRoute } from "@tanstack/react-router";
import { withMcpAuth } from "better-auth/plugins";
import { auth } from "#/lib/auth";
import { buildMcpServer } from "#/lib/mcp/server";

// Stateless Streamable HTTP MCP endpoint. withMcpAuth resolves the OAuth
// bearer token to a session (401 + WWW-Authenticate when absent), and each
// request gets a fresh server/transport pair (the SDK forbids reuse).
const mcpHandler = withMcpAuth(auth, async (req, session) => {
	const server = buildMcpServer(session.userId);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return transport.handleRequest(req);
});

const methodNotAllowed = () =>
	new Response("Method Not Allowed", {
		status: 405,
		headers: { Allow: "POST" },
	});

export const Route = createFileRoute("/api/mcp")({
	server: {
		handlers: {
			POST: ({ request }) => mcpHandler(request),
			GET: methodNotAllowed,
			DELETE: methodNotAllowed,
		},
	},
});
