import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { isAuthorizedForPrivateImage } from "#/lib/images/authorize";
import {
	EXPIRES_PARAM,
	imageKeyFromPath,
	SIGNATURE_PARAM,
} from "#/lib/images/signed-url";
import { getProducerPurchaseLinks } from "#/lib/wine/affiliate";
import { listAops, listRegions } from "#/lib/wine/service";
import type { Aop } from "#/lib/wine/types";
import { AOP_MAP_RESOURCE_URI } from "./apps";
import { registerReadTools, registerWriteTools } from "./tools";

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

/** 書き込みツール(D1を引く)を同じスタブで駆動する。 */
function collectWriteTools(userId: string) {
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
	registerWriteTools(server, userId);
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

// ---- マイセラーの書き込みツール ------------------------------------------
// 飲んだ日・評価・メモは wine_tasting(1:N)へ移したが、ツール名も引数名も変えて
// いない。既存の外部クライアント(Claude 等)が従来の呼び方を続けられることを
// 実D1上で固定する。ここが落ちたら公開済みのMCPインターフェースが壊れている。

let writeSeq = 0;
async function freshWriteUser(): Promise<string> {
	writeSeq += 1;
	const id = `mcp-write-${writeSeq}`;
	await db.insert(user).values({
		id,
		name: "mcp tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

type EntryPayload = {
	entry: {
		id: string;
		status: string;
		tasting_count: number;
		last_drank_on: string | null;
		drank_on: string | null;
		rating: number | null;
		memo: string | null;
	};
};

function writeHandler(
	tools: ReturnType<typeof collectWriteTools>,
	name: string,
): ToolHandler {
	const t = tools.get(name);
	if (!t) throw new Error(`${name} が登録されていない`);
	return t.handler;
}

describe("register_drunk_wine の後方互換", () => {
	it("旧クライアントの呼び方(name + drank_on/rating/memo)で飲用記録が1件できる", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const res = await writeHandler(
			tools,
			"register_drunk_wine",
		)({
			name: "Chablis",
			drank_on: "2020-01-02",
			rating: 4,
			memo: "good",
		});
		expect(res.isError).toBeFalsy();
		const { entry } = res.structuredContent as unknown as EntryPayload;
		// 返却は従来と同じキー・同じ値
		expect(entry.drank_on).toBe("2020-01-02");
		expect(entry.rating).toBe(4);
		expect(entry.memo).toBe("good");
		// 新しい表現も同時に載る
		expect(entry.status).toBe("finished");
		expect(entry.tasting_count).toBe(1);
		expect(entry.last_drank_on).toBe("2020-01-02");
	});

	it("status もレガシー引数も無い登録でも飲用記録が1件できる", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const res = await writeHandler(
			tools,
			"register_drunk_wine",
		)({
			name: "名前だけ",
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.status).toBe("finished");
		expect(entry.tasting_count).toBe(1);
		expect(entry.last_drank_on).toBeNull();
	});

	it("status=wishlist なら飲用記録を作らない", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const res = await writeHandler(
			tools,
			"register_drunk_wine",
		)({
			name: "気になる",
			status: "wishlist",
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.status).toBe("wishlist");
		expect(entry.tasting_count).toBe(0);
	});
});

describe("update_drunk_wine の飲用記録引数", () => {
	it("2回更新しても件数は1のまま(最新1件の in-place 更新)", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(
				await writeHandler(
					tools,
					"register_drunk_wine",
				)({
					name: "Sancerre",
					drank_on: "2020-01-01",
				})
			).structuredContent as unknown as EntryPayload
		).entry;

		const update = writeHandler(tools, "update_drunk_wine");
		await update({ id: created.id, drank_on: "2021-01-01" });
		const res = await update({ id: created.id, drank_on: "2022-01-01" });
		const { entry } = res.structuredContent as unknown as EntryPayload;
		// MCP App は保存のたびに update を投げる。追加にすると増え続けてしまう
		expect(entry.tasting_count).toBe(1);
		expect(entry.drank_on).toBe("2022-01-01");
	});

	it("飲用記録が0件のエントリに rating だけ渡すと1件作られる", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(
				await writeHandler(
					tools,
					"register_drunk_wine",
				)({
					name: "在庫",
					status: "owned",
				})
			).structuredContent as unknown as EntryPayload
		).entry;
		expect(created.tasting_count).toBe(0);

		const res = await writeHandler(
			tools,
			"update_drunk_wine",
		)({
			id: created.id,
			rating: 5,
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.tasting_count).toBe(1);
		expect(entry.rating).toBe(5);
		// 所有状態は勝手に変えない(2軸は独立)
		expect(entry.status).toBe("owned");
	});

	it("drank_on: null は列のクリアで、記録は消えない", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(
				await writeHandler(
					tools,
					"register_drunk_wine",
				)({
					name: "Muscadet",
					drank_on: "2020-01-01",
					rating: 3,
				})
			).structuredContent as unknown as EntryPayload
		).entry;

		const res = await writeHandler(
			tools,
			"update_drunk_wine",
		)({
			id: created.id,
			drank_on: null,
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.tasting_count).toBe(1);
		expect(entry.drank_on).toBeNull();
		expect(entry.last_drank_on).toBeNull();
		expect(entry.rating).toBe(3);
	});

	it("銘柄フィールドを送らず飲用記録引数だけでも成功する(空UPDATEにならない)", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(await writeHandler(tools, "register_drunk_wine")({ name: "Riesling" }))
				.structuredContent as unknown as EntryPayload
		).entry;

		const res = await writeHandler(
			tools,
			"update_drunk_wine",
		)({
			id: created.id,
			memo: "あとから追記",
		});
		expect(res.isError).toBeFalsy();
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.memo).toBe("あとから追記");
	});

	it("status で所有状態を戻せる(もう一度買った)", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(
				await writeHandler(
					tools,
					"register_drunk_wine",
				)({
					name: "Beaujolais",
					drank_on: "2020-01-01",
				})
			).structuredContent as unknown as EntryPayload
		).entry;

		const res = await writeHandler(
			tools,
			"update_drunk_wine",
		)({
			id: created.id,
			status: "owned",
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		// 手元にある かつ 飲んだことがある
		expect(entry.status).toBe("owned");
		expect(entry.tasting_count).toBe(1);
	});
});

describe("add_wine_tasting", () => {
	it("2件目以降の飲用記録を追加できる", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const created = (
			(
				await writeHandler(
					tools,
					"register_drunk_wine",
				)({
					name: "Bourgogne Rouge",
					drank_on: "2020-01-01",
				})
			).structuredContent as unknown as EntryPayload
		).entry;

		const res = await writeHandler(
			tools,
			"add_wine_tasting",
		)({
			drunk_wine_id: created.id,
			drank_on: "2024-06-06",
			rating: 5,
		});
		const { entry } = res.structuredContent as unknown as EntryPayload;
		expect(entry.tasting_count).toBe(2);
		expect(entry.last_drank_on).toBe("2024-06-06");
	});

	it("他ユーザのエントリには追加できない", async () => {
		const owner = await freshWriteUser();
		const other = await freshWriteUser();
		const created = (
			(
				await writeHandler(
					collectWriteTools(owner),
					"register_drunk_wine",
				)({
					name: "Barolo",
				})
			).structuredContent as unknown as EntryPayload
		).entry;

		const res = await writeHandler(
			collectWriteTools(other),
			"add_wine_tasting",
		)({ drunk_wine_id: created.id, rating: 1 });
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Entry not found");
	});
});

describe("list_drunk_wines", () => {
	it("未飲・気になるも含めて返し、判定用の新キーが載る", async () => {
		const userId = await freshWriteUser();
		const tools = collectWriteTools(userId);
		const register = writeHandler(tools, "register_drunk_wine");
		await register({ name: "飲んだ", drank_on: "2020-01-01" });
		await register({ name: "在庫", status: "owned" });
		await register({ name: "気になる", status: "wishlist" });

		const res = await writeHandler(tools, "list_drunk_wines")({});
		const payload = res.structuredContent as unknown as {
			count: number;
			entries: EntryPayload["entry"][];
		};
		expect(payload.count).toBe(3);
		const tasted = payload.entries.filter((e) => e.tasting_count > 0);
		expect(tasted).toHaveLength(1);
		expect(payload.entries.map((e) => e.status).sort()).toEqual([
			"finished",
			"owned",
			"wishlist",
		]);
	});
});

// ---- MCP が返す写真URL(Issue #149) ---------------------------------------
// photo_urls / photo_url はサードパーティのMCPホスト(Claude 等)へ渡り、その
// 会話履歴やログに残る。以前は無認証で恒久的に読めるURLをそのまま渡していた。
// 短命の署名を必ず載せることをここで固定する。
describe("MCP が返す写真URLの署名", () => {
	// 1x1 PNG(マジックバイトの検証を通る最小の実データ)
	const PNG_BASE64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	it("photo_urls は exp/sig 付きで、その署名だけで配信が認可される", async () => {
		const userId = await freshWriteUser();
		const res = await writeHandler(
			collectWriteTools(userId),
			"register_drunk_wine",
		)({
			name: "写真つき",
			photo_base64: PNG_BASE64,
			photo_mime_type: "image/png",
		});
		expect(res.isError).toBeFalsy();
		const { entry } = res.structuredContent as unknown as {
			entry: { photo_urls: string[]; photo_url: string | null };
		};
		expect(entry.photo_urls).toHaveLength(1);
		expect(entry.photo_url).toBe(entry.photo_urls[0]);

		const url = new URL(entry.photo_urls[0] as string);
		expect(url.searchParams.get(EXPIRES_PARAM)).toMatch(/^\d+$/);
		expect(url.searchParams.get(SIGNATURE_PARAM)).toBeTruthy();

		// 署名だけで(Cookie 無しで)配信が通ること
		const r2Key = imageKeyFromPath(url.pathname);
		expect(r2Key.startsWith(`wines/${userId}/`)).toBe(true);
		expect(
			await isAuthorizedForPrivateImage(new Request(url), url, r2Key),
		).toBe(true);

		// 署名を落とすと通らない = URLの推測不能性だけに依存していない
		const bare = new URL(url);
		bare.searchParams.delete(EXPIRES_PARAM);
		bare.searchParams.delete(SIGNATURE_PARAM);
		expect(
			await isAuthorizedForPrivateImage(new Request(bare), bare, r2Key),
		).toBe(false);
	});
});
