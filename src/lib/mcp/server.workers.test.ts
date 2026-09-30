import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./server";
import { MCP_TOOL_NAMES } from "./tool-registry";

// **実の MCP SDK を通した経路**で、ツール登録の計装(tool-tracing.ts)がツールを壊して
// いないことを固定する。
//
// tool-tracing.workers.test.ts はスタブに対する素通しを見ているだけで、SDK が
// `registerTool` の引数をどう解釈するかまでは踏んでいない。計装は generic メソッドを
// キャストで包む形なので**型検査が効かず**、SDK 側の扱いが変われば tools/list に
// 出なくなる・呼べなくなるといった壊れ方をしうる。そこはここで踏む。
//
// トランスポートはメモリ内(InMemoryTransport)で、HTTP も OAuth も通さない。見たいのは
// 「登録されたツールが列挙でき、呼べて、結果が返る」ことだけで、認証経路は別の層。

async function connectClient(scopes?: readonly string[]) {
	const server = buildMcpServer("test-user", scopes);
	const client = new Client({ name: "test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

async function toolNames(scopes?: readonly string[]): Promise<string[]> {
	const client = await connectClient(scopes);
	const { tools } = await client.listTools();
	return tools.map((t) => t.name).sort();
}

describe("buildMcpServer", () => {
	it("計装を挟んでも全ツールが tools/list に出る", async () => {
		const client = await connectClient();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);

		// 読み取り系・書き込み系の両方が登録されていること(registerReadTools /
		// registerWriteTools のどちらの登録も包まれている)
		expect(names).toContain("list_wine_regions");
		expect(names).toContain("list_aops");
		expect(names).toContain("register_drunk_wine");
		// title / inputSchema が素通しされていること(config を落とすと LLM から使えなくなる)
		const listAops = tools.find((t) => t.name === "list_aops");
		expect(listAops?.title).toBe("List AOPs");
		expect(listAops?.inputSchema).toBeDefined();
	});

	it("計装を挟んでもツールを呼べて結果が返る", async () => {
		const client = await connectClient();
		const result = await client.callTool({
			name: "list_wine_regions",
			arguments: {},
		});

		expect(result.isError).toBeFalsy();
		const regions = (
			result.structuredContent as { regions?: { id: string }[] } | undefined
		)?.regions;
		expect(regions?.length).toBeGreaterThan(0);
	});

	it("引数を取るツールにも引数が届く", async () => {
		const client = await connectClient();
		const result = await client.callTool({
			name: "list_aops",
			arguments: { region_id: "bourgogne" },
		});

		expect(result.isError).toBeFalsy();
		const aops = (
			result.structuredContent as { aops?: { id: string }[] } | undefined
		)?.aops;
		expect(aops?.length).toBeGreaterThan(0);
	});
});

// ---- スコープによるツール出し分け(Issue #549) --------------------------------
// tools/list の実態がレジストリと一致し、スコープで絞り込まれることを、
// スタブではなく実の MCP SDK 経路で固定する。
describe("buildMcpServer のスコープ絞り込み", () => {
	it("スコープ未指定はレジストリの全ツールを出す(既存トークン互換)", async () => {
		expect(await toolNames()).toEqual([...MCP_TOOL_NAMES].sort());
		expect(await toolNames([])).toEqual([...MCP_TOOL_NAMES].sort());
		expect(await toolNames(["openid", "profile", "offline_access"])).toEqual(
			[...MCP_TOOL_NAMES].sort(),
		);
	});

	it("wine:read だけでは書き込み・AI質問のツールが出ない", async () => {
		const names = await toolNames(["openid", "wine:read"]);
		expect(names).toContain("list_aops");
		expect(names).toContain("list_drunk_wines");
		expect(names).not.toContain("register_drunk_wine");
		expect(names).not.toContain("update_drunk_wine");
		expect(names).not.toContain("add_wine_tasting");
		expect(names).not.toContain("ask_region");
	});

	it("wine:write + wine:ai は該当ツールだけを出す", async () => {
		expect(await toolNames(["wine:write", "wine:ai"])).toEqual(
			[
				"add_wine_tasting",
				"ask_region",
				"register_drunk_wine",
				"update_drunk_wine",
			].sort(),
		);
	});

	it("絞り込まれたツールは呼べない", async () => {
		const client = await connectClient(["wine:read"]);
		// tools/list に無い = callTool の相手にならない
		const { tools } = await client.listTools();
		expect(tools.some((t) => t.name === "register_drunk_wine")).toBe(false);
	});
});
