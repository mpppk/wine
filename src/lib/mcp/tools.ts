import { env } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
	hasDrunkWinePatch,
	toCamelPatch,
	WINE_TASTING_FIELDS,
} from "#/lib/drunk-wine/fields";
import { DRUNK_WINE_PAGE_SIZE } from "#/lib/drunk-wine/pagination";
import { decodePhotoBase64 } from "#/lib/drunk-wine/photo";
import { BadRequestError, HttpError } from "#/lib/errors";
import {
	EXPIRES_PARAM,
	expiresAtFrom,
	imageKeyFromPath,
	SIGNATURE_PARAM,
	signImageKey,
} from "#/lib/images/signed-url";
import { getImageSigningKey } from "#/lib/images/signing-key";
import { logError, logWarn } from "#/lib/logger";
import type { McpDrunkWineEntry } from "#/lib/mcp-app/entry";
import * as aiService from "#/lib/services/ai-service";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import * as userService from "#/lib/services/user-service";
import {
	getProducerPurchaseLinks,
	getWineryPurchaseLinks,
} from "#/lib/wine/affiliate";
import { buildAffiliateConfig } from "#/lib/wine/affiliate-env";
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
	buildDrunkWineUiResource,
	buildEmbedMapUrl,
	DRUNK_WINE_RESOURCE_URI,
} from "./apps";
import {
	addWineTastingInput,
	askRegionInput,
	getAopInput,
	listAopsInput,
	listDrunkWinesInput,
	registerDrunkWineInput,
	showAopMapInput,
	updateDrunkWineInput,
} from "./schemas";

// Serialize a result as both structured content and a text mirror; MCP clients
// without structured-content support read the text form.
function ok(payload: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	};
}

/**
 * 外部の MCP クライアントへ返してよい文言に落とす。
 *
 * HttpError(BadRequest 等)は利用者に見せてよい検証・入力エラーなのでそのまま返す。
 * それ以外(D1/R2 ドライバの生エラー等)は SQL 断片やバインディング情報を、動的登録された
 * 任意の外部 MCP クライアントへ露出しうるため、汎用文言に置き換えて内部詳細を隠す(#47)。
 *
 * ツールの失敗(err)と、成功応答に混ぜる部分的失敗(写真の保存失敗)の両方がここを通る。
 * 経路ごとに書くと、後から足した経路で必ず生メッセージが漏れる(#250 がまさにそれ)。
 */
function externalMessage(e: unknown): string {
	return e instanceof HttpError
		? e.message
		: "内部エラーが発生しました。時間をおいて再度お試しください。";
}

/**
 * 失敗の記録。想定内の 4xx(HttpError)と内部エラーでレベルを分ける(#250)。
 *
 * `ask_region` の残高不足のように、正常系として HttpError を投げる経路がある。これらを
 * error で残すと `bun run logs --level error` が日常イベントで埋まり、本当の障害
 * (D1/R2/AI の失敗)が埋もれる。server fn 側の境界(`runWithHttpStatus`)と同じ方針に揃える
 * ——ただし MCP は外部クライアントが相手で入力ミスの傾向も知りたいため、無ログではなく warn。
 */
function logToolFailure(
	e: unknown,
	ctx: { tool: string; userId: string },
): void {
	const fields = { tool: ctx.tool, userId: ctx.userId, err: e };
	if (e instanceof HttpError) {
		logWarn("mcp tool rejected", { ...fields, status: e.status });
	} else {
		logError("mcp tool failed", fields);
	}
}

function err(
	e: unknown,
	ctx: { tool: string; userId: string },
): CallToolResult {
	// 失敗は必ずサーバ側に構造化ログを残す。どのツールが・どのユーザで・何で失敗したかを
	// 事後に追えるようにする(従来は err の記録が無く、障害が静かに進行していた)。
	logToolFailure(e, ctx);
	return {
		content: [{ type: "text", text: `Error: ${externalMessage(e)}` }],
		isError: true,
	};
}

// list_aops はコンパクトな要約を返し、土壌・生産者などの詳細は get_aop に誘導する
function toAopSummary(aop: Aop) {
	return {
		id: aop.id,
		name: aop.shortName,
		name_ja: aop.nameJa,
		kind: aop.kind,
		tags: aop.tags ?? [],
		subregion_id: aop.subregionId,
		colors: aop.colors,
		grape_variety_ids: aop.grapes.map((g) => g.varietyId),
	};
}

export function registerReadTools(server: McpServer, userId: string) {
	// env 依存(アフィリエイトID)はここで1回だけ解決する。get_aop の購入リンク生成に使う。
	const affiliateConfig = buildAffiliateConfig();
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
				return err(e, { tool: "get_current_user", userId });
			}
		},
	);

	server.registerTool(
		"ask_region",
		{
			title: "Ask about a wine region",
			description:
				"指定した地域(と任意のAOP)について、静的な地域データを根拠にAIが日本語で答える。" +
				"回答ごとにユーザのAIクレジットを消費する。会話を継続する場合は history に" +
				"直前までの往復を渡す(サーバは会話を保持しない)。残高不足のときはエラーを返す。",
			inputSchema: askRegionInput,
			// AIクレジットを消費するため副作用あり(読み取り専用ではない)
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async ({ region_id, aop_id, question, history, model }) => {
			try {
				const result = await aiService.answerRegionQuestion(userId, {
					regionId: region_id,
					aopId: aop_id,
					question,
					history,
					model,
				});
				if (result.blocked) {
					// 残高不足は利用者へ見せてよいメッセージ。BadRequestError にすることで
					// err() の内部エラー隠蔽を通り抜けて、そのまま MCP クライアントへ返る。
					return err(
						new BadRequestError(
							`AIクレジットが不足しています(残高 ${result.balance} / 必要 ${result.required})。` +
								"プレミアムプランで毎月より多くのクレジットが付与されます。",
						),
						{ tool: "ask_region", userId },
					);
				}
				return ok({
					answer: result.answer,
					balance: result.balance,
					actual_tokens: result.actualTokens,
				});
			} catch (e) {
				return err(e, { tool: "ask_region", userId });
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
				return err(e, { tool: "list_wine_regions", userId });
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
				return err(e, { tool: "list_grape_varieties", userId });
			}
		},
	);

	server.registerTool(
		"list_aops",
		{
			title: "List AOPs",
			description:
				"地域内のAOP(原産地呼称)一覧を返す。ブドウ品種・区分(地方名/村名/畑/" +
				"ワイナリー)・格付けタグ(特級/一級、ボルドー1855年格付け・" +
				"サンテミリオン格付け、イタリアはDOCG/DOC)で絞り込める。" +
				"土壌・生産者・解説などの詳細は get_aop で取得する。",
			inputSchema: listAopsInput,
			annotations: { readOnlyHint: true },
		},
		async ({ region_id, grape_variety_id, kind, tags }) => {
			try {
				const region = getRegion(region_id);
				if (!region) throw new BadRequestError(`Unknown region: ${region_id}`);
				if (!region.enabled)
					throw new BadRequestError(`Region not yet available: ${region_id}`);
				if (grape_variety_id && !getVariety(grape_variety_id))
					throw new BadRequestError(
						`Unknown grape variety: ${grape_variety_id}`,
					);
				const aops = listAops({
					regionId: region_id,
					grapeVarietyId: grape_variety_id,
					kind,
					tags,
				}).map(toAopSummary);
				return ok({
					region_id,
					grape_variety_id: grape_variety_id ?? null,
					count: aops.length,
					aops,
				});
			} catch (e) {
				return err(e, { tool: "list_aops", userId });
			}
		},
	);

	server.registerTool(
		"get_aop",
		{
			title: "Get AOP details",
			description:
				"AOP(原産地呼称)1件の詳細(区分・格付けタグ・色・品種・土壌・主要生産者・解説)を返す。" +
				"生産者には楽天市場/Amazonでそのワインを探せる購入リンク(アフィリエイト広告)が付く。" +
				"境界ポリゴンは geojson_url のGeoJSONに含まれる(idAppプロパティで結合)。",
			inputSchema: getAopInput,
			annotations: { readOnlyHint: true },
		},
		async ({ aop_id }) => {
			try {
				const aop = getAop(aop_id);
				if (!aop) throw new BadRequestError(`Unknown AOP: ${aop_id}`);
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
						kind: aop.kind,
						tags: aop.tags ?? [],
						colors: aop.colors,
						grapes: aop.grapes.map((g) => ({
							variety_id: g.varietyId,
							variety_name_ja: getVariety(g.varietyId)?.nameJa ?? null,
							role: g.role,
						})),
						soil: aop.soil,
						// winery(シャトー)の producers は所有者/運営体なので購入リンクは
						// 生産者ではなくAOP自体(purchase_links)に付ける
						producers: aop.producers.map((p) => ({
							name: p.name,
							// 代表キュヴェ・単独所有畑・傘下エステート等の補足(無ければ null)
							note: p.note ?? null,
							purchase_links:
								aop.kind === "winery"
									? null
									: getProducerPurchaseLinks(p, affiliateConfig),
						})),
						// wineryのみ: シャトー自体のワインを探す購入リンク(アフィリエイト広告)
						purchase_links: getWineryPurchaseLinks(aop, affiliateConfig),
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
				return err(e, { tool: "get_aop", userId });
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
				if (!region) throw new BadRequestError(`Unknown region: ${region_id}`);
				if (!region.enabled)
					throw new BadRequestError(`Region not yet available: ${region_id}`);
				if (grape_variety_id && !getVariety(grape_variety_id))
					throw new BadRequestError(
						`Unknown grape variety: ${grape_variety_id}`,
					);
				if (aop_id && !getAop(aop_id))
					throw new BadRequestError(`Unknown AOP: ${aop_id}`);
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
				return err(e, { tool: "show_aop_map", userId });
			}
		},
	);
}

/**
 * マイセラー写真の絶対URL。ホスト(iframe外)から参照できるよう絶対URLにしたうえで、
 * 短命の署名を付ける。MCPホストは第三者であり Cookie も乗らないため、この署名が
 * 唯一の認可根拠になる(Issue #149)。期限が切れたらツールを呼び直せば新しいURLが返る。
 */
async function toSignedPhotoUrl(
	relativeUrl: string,
	updatedAt: number,
): Promise<string> {
	const r2Key = imageKeyFromPath(relativeUrl);
	const expiresAt = expiresAtFrom(Date.now());
	const sig = await signImageKey(await getImageSigningKey(), r2Key, expiresAt);
	const url = new URL(relativeUrl, env.BETTER_AUTH_URL);
	// /api/images は immutable キャッシュで返し、写真差し替えでもキーが
	// 変わらないことがあるため updatedAt でキャッシュバストする。
	url.searchParams.set("v", String(updatedAt));
	url.searchParams.set(EXPIRES_PARAM, String(expiresAt));
	url.searchParams.set(SIGNATURE_PARAM, sig);
	return url.toString();
}

// MCPクライアントへ返すエントリ表現。photo_url はホスト(iframe外)から
// 参照できるよう絶対URLにする。形の単一情報源は McpDrunkWineEntry で、
// MCP App のフォーム(/embed/drunk-wine)が同じ型で受け取る。
async function toEntryPayload(
	entry: DrunkWineEntry,
): Promise<McpDrunkWineEntry> {
	// photo_urls は全写真(表示順・先頭=代表)、photo_url は後方互換の代表1枚。
	const photoUrls = await Promise.all(
		entry.photoUrls.map((url) => toSignedPhotoUrl(url, entry.updatedAt)),
	);
	return {
		id: entry.id,
		name: entry.name,
		status: entry.status,
		last_drank_on: entry.lastDrankOn,
		tasting_count: entry.tastingCount,
		drank_on: entry.lastDrankOn,
		aop_id: entry.aopId,
		aop_name_ja: entry.aopNameJa,
		region_id: entry.regionId,
		rating: entry.lastRating,
		memo: entry.lastMemo,
		vintage: entry.vintage,
		grape_variety_ids: entry.grapeVarietyIds,
		producer: entry.producer,
		price: entry.price,
		photo_urls: photoUrls,
		photo_url: photoUrls[0] ?? null,
		created_at: entry.createdAt,
		updated_at: entry.updatedAt,
	};
}

/**
 * 既存写真をすべて保持しつつ末尾に新規1枚を追記する layout を作る。
 * MCPは単一 photo_base64 を「追記」の意味で扱う(上限超過は syncDrunkWinePhotos が拒否)。
 */
function appendPhotoLayout(
	entry: DrunkWineEntry,
	photo: { bytes: Uint8Array; mimeType: string },
): drunkWineService.PhotoLayoutItem[] {
	return [
		...entry.photoUrls.map(
			(url): drunkWineService.PhotoLayoutItem => ({
				kind: "existing",
				key: imageKeyFromPath(url),
			}),
		),
		{ kind: "new", bytes: photo.bytes, mimeType: photo.mimeType },
	];
}

/**
 * 銘柄のパッチと飲用記録のパッチを分離する。飲んだ日・評価・メモは wine_tasting へ
 * 移ったが、ツールの引数名は変えていない(既存クライアントの呼び方を壊さないため)。
 * 未指定のキーは落とし、null は「その列をクリア」の意で保持する。
 */
function splitTastingArgs(args: Record<string, unknown>): {
	drankOn?: string | null;
	rating?: number | null;
	memo?: string | null;
} | null {
	const patch: Record<string, unknown> = {};
	for (const d of WINE_TASTING_FIELDS) {
		if (args[d.snakeKey] !== undefined) patch[d.camelKey] = args[d.snakeKey];
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

// 写真引数を検証・デコードする。DB書き込み前に呼び、不正なら先に失敗させる。
function decodePhotoArgs(args: {
	photo_base64?: string;
	photo_mime_type?: string;
}): { bytes: Uint8Array; mimeType: string } | null {
	if (!args.photo_base64) return null;
	if (!args.photo_mime_type) {
		throw new BadRequestError(
			"photo_mime_type is required when photo_base64 is set",
		);
	}
	return {
		bytes: decodePhotoBase64(args.photo_base64, args.photo_mime_type),
		mimeType: args.photo_mime_type,
	};
}

export function registerWriteTools(server: McpServer, userId: string) {
	server.registerTool(
		"register_drunk_wine",
		{
			title: "Register Drunk Wine",
			description:
				"ワインをマイセラーに記録する。飲んだワインだけでなく、買ってまだ飲んで" +
				"いないボトルや気になっているワインも status で登録できる。ボトルラベルの" +
				"写真から読み取ったワイン名・ヴィンテージ・生産者・AOPなどをそのまま渡す用途を想定。" +
				"写真自体も photo_base64 + photo_mime_type で添付すると保存される" +
				"(1エントリに複数枚保持でき、添付は既存写真への追記。最大6枚)。" +
				"aop_id は list_aops、grape_variety_ids は list_grape_varieties の id を使う(いずれも任意)。" +
				"drank_on / rating / memo を渡すと飲用記録1件付きで登録する。" +
				"対応ホストでは登録内容をその場で編集できるフォームUIが描画される。",
			inputSchema: registerDrunkWineInput,
			annotations: { readOnlyHint: false, destructiveHint: false },
			// MCP Apps (SEP): 登録結果の編集フォームUIを関連付ける
			_meta: { ui: { resourceUri: DRUNK_WINE_RESOURCE_URI } },
		},
		async (args) => {
			try {
				const photo = decodePhotoArgs(args);
				const tasting = splitTastingArgs(args);
				let entry = await drunkWineService.createDrunkWine(userId, {
					...toCamelPatch(args),
					name: args.name,
					// null(クリア)は作成時には意味を持たないので undefined に倒す
					...(tasting
						? {
								tasting: {
									drankOn: tasting.drankOn ?? undefined,
									rating: tasting.rating ?? undefined,
									memo: tasting.memo ?? undefined,
								},
							}
						: {}),
				});
				// エントリ作成後の写真保存失敗を isError にするとクライアントが
				// リトライして重複登録するため、entry.id 付きの成功として返し
				// photo_error で再添付(update_drunk_wine)を促す
				let photoError: string | null = null;
				if (photo) {
					try {
						entry = await drunkWineService.syncDrunkWinePhotos(
							userId,
							entry.id,
							appendPhotoLayout(entry, photo),
						);
					} catch (e) {
						// 成功応答に混ぜて返すため err() を通らない。ここで記録しないと
						// 「Claude から写真付きで登録すると写真だけ消える」が無ログで進行する
						// (Web 経路は wine-photos.ts で記録済み。#250)。
						logError("mcp photo attach failed", {
							tool: "register_drunk_wine",
							userId,
							entryId: entry.id,
							err: e,
						});
						photoError = `写真の保存に失敗しました(記録自体は作成済み。update_drunk_wine で id を指定して再添付できる): ${externalMessage(e)}`;
					}
				}
				const payload = {
					entry: await toEntryPayload(entry),
					...(photoError ? { photo_error: photoError } : {}),
				};
				// mcp-ui 対応ホスト向けに編集フォームUIリソースを添付する
				const ui = buildDrunkWineUiResource(env.BETTER_AUTH_URL, entry);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }, ui],
					structuredContent: payload as unknown as Record<string, unknown>,
				};
			} catch (e) {
				return err(e, { tool: "register_drunk_wine", userId });
			}
		},
	);

	server.registerTool(
		"update_drunk_wine",
		{
			title: "Update Drunk Wine",
			description:
				"記録済みのワインを更新する。id と変更したいフィールドだけを渡す" +
				"(未指定のフィールドは変更されない)。status で所有状態を変えられる" +
				"(飲み終えた→また買った場合は owned に戻す)。" +
				"drank_on / rating / memo は最新の飲用記録を更新する(飲用記録が無ければ1件作る)。" +
				"別の日に飲んだ記録を追加するには add_wine_tasting を使う。" +
				"写真は photo_base64 + photo_mime_type で既存写真に追記できる(最大6枚)。",
			inputSchema: updateDrunkWineInput,
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (args) => {
			try {
				const photo = decodePhotoArgs(args);
				const patch = toCamelPatch(args);
				const tasting = splitTastingArgs(args);
				// 銘柄・飲用記録・写真のいずれも指定が無ければ空UPDATEになるため、
				// 「変更のあるものだけ順に適用する」形で分岐する
				let entry = hasDrunkWinePatch(patch)
					? await drunkWineService.updateDrunkWine(userId, {
							id: args.id,
							...patch,
						})
					: await drunkWineService.getDrunkWine(userId, args.id);
				if (tasting) {
					entry =
						(await drunkWineService.updateLatestWineTasting(
							userId,
							args.id,
							tasting,
						)) ?? entry;
				}
				if (photo) {
					entry = await drunkWineService.syncDrunkWinePhotos(
						userId,
						args.id,
						appendPhotoLayout(entry, photo),
					);
				}
				return ok({ entry: await toEntryPayload(entry) });
			} catch (e) {
				return err(e, { tool: "update_drunk_wine", userId });
			}
		},
	);

	server.registerTool(
		"list_drunk_wines",
		{
			title: "List Drunk Wines",
			description:
				"マイセラーに記録したワインの一覧を新しい順に返す。飲んだワインだけでなく" +
				"未飲(status=owned)・気になる(status=wishlist)も含む。" +
				"飲んだことがあるかは tasting_count > 0 で判定する。" +
				"エントリの編集には update_drunk_wine に entry.id を渡す。" +
				"件数が多い場合はページングされる: next_cursor が返ったら cursor に渡して続きを取る。",
			inputSchema: listDrunkWinesInput,
			annotations: { readOnlyHint: true },
		},
		async ({ limit, cursor, filter }) => {
			try {
				const { entries, nextCursor } = await drunkWineService.listDrunkWines(
					userId,
					{ limit: limit ?? DRUNK_WINE_PAGE_SIZE, cursor, filter },
				);
				return ok({
					count: entries.length,
					// 未指定でもページングするので、続きの有無を必ず返す
					next_cursor: nextCursor,
					entries: await Promise.all(entries.map(toEntryPayload)),
				});
			} catch (e) {
				return err(e, { tool: "list_drunk_wines", userId });
			}
		},
	);

	server.registerTool(
		"add_wine_tasting",
		{
			title: "Add Wine Tasting",
			description:
				"記録済みのワインに飲用記録を1件追加する。同じワインを複数回飲んだ場合に、" +
				"回ごとの日付・評価・メモを残せる。最新の飲用記録を書き換えたいだけなら" +
				"update_drunk_wine の drank_on / rating / memo を使う。",
			inputSchema: addWineTastingInput,
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (args) => {
			try {
				const entry = await drunkWineService.addWineTasting(
					userId,
					args.drunk_wine_id,
					{
						drankOn: args.drank_on,
						rating: args.rating,
						memo: args.memo,
					},
				);
				return ok({ entry: await toEntryPayload(entry) });
			} catch (e) {
				return err(e, { tool: "add_wine_tasting", userId });
			}
		},
	);
}
