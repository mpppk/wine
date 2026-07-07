import { env } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as userService from "#/lib/services/user-service";
import {
	getAop,
	getRegion,
	getVariety,
	listAops,
	listRegions,
} from "#/lib/wine/service";
import type { Aop } from "#/lib/wine/types";
import { GRAPE_VARIETIES } from "#/lib/wine/varieties";
import {
	AOP_MAP_RESOURCE_URI,
	buildAopMapUiResource,
	buildEmbedMapUrl,
} from "./apps";
import { getAopInput, listAopsInput, showAopMapInput } from "./schemas";

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

// list_aops はコンパクトな要約を返し、土壌・生産者などの詳細は get_aop に誘導する
function toAopSummary(aop: Aop) {
	return {
		id: aop.id,
		name: aop.shortName,
		name_ja: aop.nameJa,
		classification: aop.classification,
		premier_cru: aop.premierCru,
		subregion_id: aop.subregionId,
		colors: aop.colors,
		grape_variety_ids: aop.grapes.map((g) => g.varietyId),
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

	server.registerTool(
		"list_wine_regions",
		{
			title: "List wine regions",
			description:
				"ワインAOP学習アプリで閲覧できる地域(ブルゴーニュ等)の一覧を返す。" +
				"enabled=true の地域は list_aops / show_aop_map で利用できる。",
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				const regions = listRegions().map((r) => ({
					id: r.id,
					name_ja: r.nameJa,
					name_local: r.nameLocal,
					country: r.country,
					enabled: r.enabled,
					aop_count: r.aopCount,
					subregions: r.subregions,
					description: r.description,
				}));
				return ok({ regions });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"list_grape_varieties",
		{
			title: "List grape varieties",
			description:
				"AOPメタデータで使われるブドウ品種マスタを返す。" +
				"list_aops の grape_variety_id フィルタに使える。",
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				return ok({ varieties: GRAPE_VARIETIES });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"list_aops",
		{
			title: "List AOPs",
			description:
				"地域内のAOP(原産地呼称)一覧を返す。ブドウ品種や格付けで絞り込める。" +
				"土壌・生産者・解説などの詳細は get_aop で取得する。",
			inputSchema: listAopsInput,
			annotations: { readOnlyHint: true },
		},
		async ({ region_id, grape_variety_id, classification }) => {
			try {
				const region = getRegion(region_id);
				if (!region) throw new Error(`Unknown region: ${region_id}`);
				if (!region.enabled)
					throw new Error(`Region not yet available: ${region_id}`);
				if (grape_variety_id && !getVariety(grape_variety_id))
					throw new Error(`Unknown grape variety: ${grape_variety_id}`);
				const aops = listAops({
					regionId: region_id,
					grapeVarietyId: grape_variety_id,
					classification,
				}).map(toAopSummary);
				return ok({
					region_id,
					grape_variety_id: grape_variety_id ?? null,
					count: aops.length,
					aops,
				});
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"get_aop",
		{
			title: "Get AOP details",
			description:
				"AOP(原産地呼称)1件の詳細(格付け・色・品種・土壌・主要生産者・解説)を返す。" +
				"境界ポリゴンは geojson_url のGeoJSONに含まれる(idAppプロパティで結合)。",
			inputSchema: getAopInput,
			annotations: { readOnlyHint: true },
		},
		async ({ aop_id }) => {
			try {
				const aop = getAop(aop_id);
				if (!aop) throw new Error(`Unknown AOP: ${aop_id}`);
				const region = getRegion(aop.region);
				return ok({
					aop: {
						id: aop.id,
						id_app: aop.idApp,
						name: aop.name,
						short_name: aop.shortName,
						name_ja: aop.nameJa,
						region_id: aop.region,
						subregion_id: aop.subregionId,
						classification: aop.classification,
						premier_cru: aop.premierCru,
						colors: aop.colors,
						grapes: aop.grapes.map((g) => ({
							variety_id: g.varietyId,
							variety_name_ja: getVariety(g.varietyId)?.nameJa ?? null,
							role: g.role,
						})),
						soil: aop.soil,
						producers: aop.producers,
						description: aop.description,
					},
					geojson_url: region?.geojsonPath
						? new URL(region.geojsonPath, env.BETTER_AUTH_URL).toString()
						: null,
					map_url: buildEmbedMapUrl(env.BETTER_AUTH_URL, {
						regionId: aop.region,
						aopId: aop.id,
					}),
				});
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"show_aop_map",
		{
			title: "Show AOP map",
			description:
				"地域のAOP地図を表示する。ブドウ品種を指定すると、その品種の使用が" +
				"許可されているAOPだけをハイライトした地図になる。対応ホストでは" +
				"インタラクティブな地図UIが描画される。",
			inputSchema: showAopMapInput,
			annotations: { readOnlyHint: true },
			// MCP Apps (SEP): associate a UI so hosts render the map inline.
			_meta: { ui: { resourceUri: AOP_MAP_RESOURCE_URI } },
		},
		async ({ region_id, grape_variety_id, aop_id }) => {
			try {
				const region = getRegion(region_id);
				if (!region) throw new Error(`Unknown region: ${region_id}`);
				if (!region.enabled)
					throw new Error(`Region not yet available: ${region_id}`);
				if (grape_variety_id && !getVariety(grape_variety_id))
					throw new Error(`Unknown grape variety: ${grape_variety_id}`);
				if (aop_id && !getAop(aop_id))
					throw new Error(`Unknown AOP: ${aop_id}`);
				const params = {
					regionId: region_id,
					grapeVarietyId: grape_variety_id,
					aopId: aop_id,
				};
				const payload = {
					region_id,
					grape_variety_id: grape_variety_id ?? null,
					aop_id: aop_id ?? null,
					map_url: buildEmbedMapUrl(env.BETTER_AUTH_URL, params),
					aop_count: listAops({
						regionId: region_id,
						grapeVarietyId: grape_variety_id,
					}).length,
				};
				// mcp-ui 対応ホスト向けに、地図を描画する埋め込みUIリソースを添付する
				const ui = buildAopMapUiResource(env.BETTER_AUTH_URL, params);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }, ui],
					structuredContent: payload as Record<string, unknown>,
				};
			} catch (e) {
				return err(e);
			}
		},
	);
}

// 現状、ワインAOPデータは読み取り専用(静的データ)なので書き込みツールはない。
export function registerWriteTools(_server: McpServer, _userId: string) {}
