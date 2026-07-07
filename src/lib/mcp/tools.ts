import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as userService from "#/lib/services/user-service";

// Serialize a result as both structured content and a text mirror; MCP clients
// without structured-content support read the text form.
function ok(payload: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	};
}

function err(e: unknown): CallToolResult {
	const message = e instanceof Error ? e.message : String(e);
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true,
	};
}

export function registerReadTools(server: McpServer, userId: string) {
	server.registerTool(
		"get_current_user",
		{
			title: "Get current user",
			description:
				"Get the account info (id, name, email, avatar) of the signed-in " +
				"user this MCP connection is authenticated as.",
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				const user = await userService.getCurrentUser(userId);
				return ok({ user });
			} catch (e) {
				return err(e);
			}
		},
	);
}

// Placeholder for future write tools (e.g. wine AOP data mutations). The todo
// write tools were removed with the todos feature; keep this hook so new tools
// have an obvious home.
export function registerWriteTools(_server: McpServer, _userId: string) {}
