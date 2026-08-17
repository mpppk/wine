import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./server";

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

async function connectClient() {
	const server = buildMcpServer("test-user");
	const client = new Client({ name: "test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
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
