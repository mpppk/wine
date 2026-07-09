import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	AOP_MAP_RESOURCE_URI,
	buildAopMapAppHtml,
	buildDrunkWineAppHtml,
	DRUNK_WINE_RESOURCE_URI,
} from "./apps";
import { registerReadTools, registerWriteTools } from "./tools";

// Build a per-request MCP server bound to the authenticated user. The SDK
// forbids reusing a connected server across requests, and per-request
// instances are what make the stateless transport safe on Workers.
export function buildMcpServer(userId: string): McpServer {
	const server = new McpServer({ name: "wine", version: "1.0.0" });
	registerReadTools(server, userId);
	registerWriteTools(server, userId);
	registerApps(server);
	return server;
}

// Register the MCP Apps (SEP) UI resource. `show_aop_map` points at this via
// `_meta.ui.resourceUri`; hosts fetch it and render the returned HTML, then
// push the tool input/result into the iframe so it can show the right region.
function registerApps(server: McpServer) {
	const baseUrl = env.BETTER_AUTH_URL;
	// ベースマップのタイル・スタイル・フォントは OpenFreeMap から読み込む
	const tileOrigin = "https://tiles.openfreemap.org";
	server.registerResource(
		"aop-map",
		AOP_MAP_RESOURCE_URI,
		{
			title: "ワインAOP地図",
			description:
				"地域のAOP境界を表示するインタラクティブ地図。MCP Appsホストが描画する。",
			mimeType: "text/html;profile=mcp-app",
		},
		() => ({
			contents: [
				{
					uri: AOP_MAP_RESOURCE_URI,
					mimeType: "text/html;profile=mcp-app",
					text: buildAopMapAppHtml(baseUrl),
					_meta: {
						ui: {
							csp: {
								connectDomains: [baseUrl, tileOrigin],
								resourceDomains: [baseUrl, tileOrigin],
							},
						},
					},
				},
			],
		}),
	);

	// register_drunk_wine の結果を表示・編集するフォーム。品種マスタの
	// fetch と写真表示のため自ホストのみCSPで許可する。
	server.registerResource(
		"drunk-wine",
		DRUNK_WINE_RESOURCE_URI,
		{
			title: "飲んだワイン編集フォーム",
			description:
				"register_drunk_wine で記録したワインを表示し、その場で編集できる" +
				"フォーム。MCP Appsホストが描画する。",
			mimeType: "text/html;profile=mcp-app",
		},
		() => ({
			contents: [
				{
					uri: DRUNK_WINE_RESOURCE_URI,
					mimeType: "text/html;profile=mcp-app",
					text: buildDrunkWineAppHtml(baseUrl),
					_meta: {
						ui: {
							csp: {
								connectDomains: [baseUrl],
								resourceDomains: [baseUrl],
							},
						},
					},
				},
			],
		}),
	);
}
