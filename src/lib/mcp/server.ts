import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools, registerWriteTools } from "./tools";

// Build a per-request MCP server bound to the authenticated user. The SDK
// forbids reusing a connected server across requests, and per-request
// instances are what make the stateless transport safe on Workers.
export function buildMcpServer(userId: string): McpServer {
	const server = new McpServer({ name: "todo-app2026", version: "1.0.0" });
	registerReadTools(server, userId);
	registerWriteTools(server, userId);
	return server;
}
