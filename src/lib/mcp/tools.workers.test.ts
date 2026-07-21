import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { getProducerPurchaseLinks } from "#/lib/wine/affiliate";
import { listAops, listRegions } from "#/lib/wine/service";
import type { Aop } from "#/lib/wine/types";
import { AOP_MAP_RESOURCE_URI } from "./apps";
import { registerReadTools } from "./tools";

// tools.ts はトップレベルで `cloudflare:workers` の env を評価する(get_aop の URL 生成・
// affiliate 設定)。workers プール上なら env が使えるので、実ハンドラを駆動して
// list_aops / get_aop / show_aop_map の正常系・異常系・購入リンクの出し分けを検証する
// (Issue #51)。BETTER_AUTH_URL はテスト設定(vitest.config.ts)で与えている。

const BASE_URL = "http://localhost:3000";

// err() が返すエラーレスポンスのテキストミラー(content[0])を取り出す。
function firstText(res: CallToolResult): string {
	const first = (res.content ?? [])[0] as
		| { type?: string; text?: string }
		| undefined;
	return first?.text ?? "";
}

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

// registerTool(name, config, handler) を記録するスタブ McpServer。実トランスポートを
// 立てずにハンドラを直接呼ぶ。get_current_user 等 DB を引くツールは呼ばない。
function collectReadTools(userId = "tester") {
	const tools = new Map<
		string,
		{ config: Record<string, unknown>; handler: ToolHandler }
	>();
	const server = {
		registerTool(
			name: string,
			config: Record<string, unknown>,
			handler: ToolHandler,
		) {
			tools.set(name, { config, handler });
		},
	} as unknown as McpServer;
	registerReadTools(server, userId);
	return tools;
}

const tools = collectReadTools();
const enabledRegions = listRegions().filter((r) => r.enabled);
const region = enabledRegions[0];
if (!region) throw new Error("有効な地域が無い(テストデータ前提が崩れている)");

function findAop(pred: (a: Aop) => boolean): Aop | undefined {
	for (const r of enabledRegions) {
		const found = listAops({ regionId: r.id }).find(pred);
		if (found) return found;
	}
	return undefined;
}

describe("list_aops", () => {
	const handler = () => {
		const t = tools.get("list_aops");
		if (!t) throw new Error("list_aops が登録されていない");
		return t.handler;
	};

	it("正常系: 地域のAOP要約一覧を count 付きで返す", async () => {
		const res = await handler()({ region_id: region.id });
		expect(res.isError).toBeFalsy();
		const payload = res.structuredContent as {
			region_id: string;
			count: number;
			aops: { id: string; kind: string }[];
		};
		expect(payload.region_id).toBe(region.id);
		expect(payload.count).toBe(payload.aops.length);
		expect(payload.count).toBeGreaterThan(0);
		expect(payload.aops[0]).toHaveProperty("id");
		expect(payload.aops[0]).toHaveProperty("grape_variety_ids");
	});

	it("異常系: 未知の region_id は BadRequest 文言のまま isError で返る(汎用文言に潰さない)", async () => {
		const res = await handler()({ region_id: "___no_such_region___" });
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Unknown region");
	});

	it("異常系: 未知の grape_variety_id も BadRequest 文言で返る", async () => {
		const res = await handler()({
			region_id: region.id,
			grape_variety_id: "___no_such_variety___",
		});
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Unknown grape variety");
	});
});

describe("get_aop", () => {
	const handler = () => {
		const t = tools.get("get_aop");
		if (!t) throw new Error("get_aop が登録されていない");
		return t.handler;
	};

	it("winery: 生産者側の購入リンクは null、AOP自体に購入リンクが付く", async () => {
		const winery = findAop((a) => a.kind === "winery");
		if (!winery) throw new Error("winery 区分のAOPが見つからない");
		const res = await handler()({ aop_id: winery.id });
		expect(res.isError).toBeFalsy();
		const payload = res.structuredContent as {
			aop: {
				kind: string;
				producers: { purchase_links: unknown }[];
				purchase_links: unknown;
			};
		};
		expect(payload.aop.kind).toBe("winery");
		// winery は producers 側の購入リンクを出さない
		for (const p of payload.aop.producers) {
			expect(p.purchase_links).toBeNull();
		}
		// winery 自体のワインを探すリンクは AOP レベルに付く
		expect(payload.aop.purchase_links).not.toBeNull();
	});

	it("winery以外: AOP自体の購入リンクは null、生産者側にリンクが付く", async () => {
		// リンク可能な生産者を持つ非wineryのAOPを実データから選ぶ(分岐が意味を持つ前提)
		const producerAop = findAop(
			(a) =>
				a.kind !== "winery" &&
				a.producers.some((p) => getProducerPurchaseLinks(p) !== null),
		);
		if (!producerAop)
			throw new Error("リンク可能な生産者を持つ非wineryのAOPが無い");
		const res = await handler()({ aop_id: producerAop.id });
		const payload = res.structuredContent as {
			aop: {
				kind: string;
				producers: { purchase_links: unknown }[];
				purchase_links: unknown;
			};
		};
		expect(payload.aop.kind).not.toBe("winery");
		// 非winery は AOP レベルの購入リンクを持たない
		expect(payload.aop.purchase_links).toBeNull();
		// 少なくとも1件の生産者に購入リンクが付く
		expect(payload.aop.producers.some((p) => p.purchase_links !== null)).toBe(
			true,
		);
	});

	it("geojson_url / map_url が BETTER_AUTH_URL を基点に組まれる", async () => {
		const anyAop = findAop(() => true);
		if (!anyAop) throw new Error("AOPが無い");
		const res = await handler()({ aop_id: anyAop.id });
		const payload = res.structuredContent as {
			geojson_url: string | null;
			map_url: string;
		};
		expect(payload.map_url.startsWith(BASE_URL)).toBe(true);
		if (payload.geojson_url) {
			expect(payload.geojson_url.startsWith(BASE_URL)).toBe(true);
		}
	});

	it("異常系: 未知の aop_id は BadRequest 文言で返る", async () => {
		const res = await handler()({ aop_id: "___no_such_aop___" });
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Unknown AOP");
	});
});

describe("show_aop_map", () => {
	it("UIリソースを添付し、_meta で App の resourceUri を宣言する", async () => {
		const entry = tools.get("show_aop_map");
		if (!entry) throw new Error("show_aop_map が登録されていない");
		// ツール定義の _meta に App の resourceUri が宣言されている
		const meta = entry.config._meta as { ui?: { resourceUri?: string } };
		expect(meta?.ui?.resourceUri).toBe(AOP_MAP_RESOURCE_URI);

		const res = await entry.handler({ region_id: region.id });
		expect(res.isError).toBeFalsy();
		const payload = res.structuredContent as {
			region_id: string;
			map_url: string;
			aop_count: number;
		};
		expect(payload.region_id).toBe(region.id);
		expect(payload.map_url.startsWith(BASE_URL)).toBe(true);
		expect(payload.aop_count).toBeGreaterThan(0);
		// content は [テキストミラー, UIリソース] の2要素
		expect(res.content?.length).toBe(2);
	});

	it("異常系: 未知の region_id は BadRequest 文言で返る", async () => {
		const entry = tools.get("show_aop_map");
		if (!entry) throw new Error("show_aop_map が登録されていない");
		const res = await entry.handler({ region_id: "___no_such_region___" });
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Unknown region");
	});
});
