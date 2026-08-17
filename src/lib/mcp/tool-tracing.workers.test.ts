import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { type ToolRegistrar, traceToolCalls } from "./tool-tracing";

// ここで守りたいのは**計装がツールの挙動を変えないこと**。`registerTool` は
// ツールごとに型が変わる generic メソッドで、包むのに1箇所キャストを使っている——
// 型検査が効かない箇所なので、引数・戻り値・例外の素通しをテストで固定する。
// (記録されたスパンの中身は実行中のコードからは読めない。span.workers.test.ts 参照)

/** registerTool(name, config, handler) を記録するだけのスタブ。 */
function stubRegistrar() {
	const registered: {
		name: string;
		config: unknown;
		handler: (...args: never[]) => unknown;
	}[] = [];
	const server = {
		registerTool(name: string, config: unknown, handler: unknown) {
			registered.push({
				name,
				config,
				handler: handler as (...args: never[]) => unknown,
			});
			return { name } as unknown;
		},
	} as unknown as ToolRegistrar & McpServer;
	return { server, registered };
}

describe("traceToolCalls", () => {
	it("ツール名と設定をそのまま登録する", () => {
		const { server, registered } = stubRegistrar();
		traceToolCalls(server);
		const config = { title: "テスト", description: "説明" };
		server.registerTool("list_aops", config, async () => ({ content: [] }));

		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("list_aops");
		expect(registered[0]?.config).toBe(config);
	});

	it("ハンドラの引数と戻り値を素通しする", async () => {
		const { server, registered } = stubRegistrar();
		traceToolCalls(server);
		const seen: unknown[] = [];
		server.registerTool("get_aop", {}, async (...args: unknown[]) => {
			seen.push(...args);
			return { content: [{ type: "text", text: "ok" }] };
		});

		const result = await registered[0]?.handler(
			...([{ id: "bordeaux" }, { requestId: "1" }] as never[]),
		);

		expect(seen).toEqual([{ id: "bordeaux" }, { requestId: "1" }]);
		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	it("ハンドラの例外を握り潰さない", async () => {
		const { server, registered } = stubRegistrar();
		traceToolCalls(server);
		server.registerTool("register_drunk_wine", {}, async () => {
			throw new Error("tool failed");
		});

		await expect(registered[0]?.handler()).rejects.toThrow("tool failed");
	});

	it("包んだ後に登録した全ツールに乗る", () => {
		const { server, registered } = stubRegistrar();
		traceToolCalls(server);
		server.registerTool("a", {}, async () => ({ content: [] }));
		server.registerTool("b", {}, async () => ({ content: [] }));

		expect(registered.map((r) => r.name)).toEqual(["a", "b"]);
	});
});
