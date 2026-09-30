import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFileRoute } from "@tanstack/react-router";
import { withMcpAuth } from "better-auth/plugins";
import { auth } from "#/lib/auth";
import { logWarn } from "#/lib/logger";
import { bannedResponse } from "#/lib/mcp/ban-guard";
import { buildMcpServer } from "#/lib/mcp/server";
import { isUserBanned } from "#/lib/services/user-service";

// Stateless Streamable HTTP MCP endpoint. withMcpAuth resolves the OAuth
// bearer token to a session (401 + WWW-Authenticate when absent), and each
// request gets a fresh server/transport pair (the SDK forbids reuse).
const mcpHandler = withMcpAuth(auth, async (req, session) => {
	// BAN の実効範囲を MCP へ広げる多層防御(#330)。BAN 時に oauth_access_token は
	// 失効させるが(admin-actions.banUser)、失効の書き込みが落ちた場合や失効後に
	// 残ったトークンでも、停止中のユーザが書き込み・AIクレジット消費を続けられない
	// ようにここで塞ぐ。better-auth の mcp プラグインはトークンの有無と期限しか
	// 見ないため、この確認をしないと BAN が MCP だけ素通りする。
	if (await isUserBanned(session.userId)) {
		logWarn("mcp request from banned user", { userId: session.userId });
		return bannedResponse();
	}
	// トークンの付与スコープで登録ツールを出し分ける(Issue #549)。wine スコープを
	// 含まない既存トークンは従来どおり全ツールを登録する(互換維持)。
	const grantedScopes = (session.scopes ?? "").split(" ").filter(Boolean);
	const server = buildMcpServer(session.userId, grantedScopes);
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
