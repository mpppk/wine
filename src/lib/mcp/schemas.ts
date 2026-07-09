import { z } from "zod";
import { drunkWineFields } from "#/lib/drunk-wine/schema";
import { AOP_TAG_IDS } from "#/lib/wine/tags";

// MCPツールの入力スキーマ。DB/ランタイム依存を持たせず、vitest(jsdom)で
// ユニットテストできる形に保つ。McpServer.registerTool の inputSchema には
// zod の raw shape オブジェクトをそのまま渡す。

export const listAopsInput = {
	region_id: z
		.string()
		.describe("地域ID (list_wine_regions の id。例: 'bourgogne')"),
	grape_variety_id: z
		.string()
		.optional()
		.describe(
			"ブドウ品種ID (list_grape_varieties の id。例: 'pinot-noir')。" +
				"指定するとその品種の使用が許可されているAOPのみ返す。",
		),
	kind: z
		.enum(["regional", "village", "vineyard", "winery"])
		.optional()
		.describe("区分で絞り込む (地方名/村名/畑/ワイナリー)"),
	tags: z
		.array(z.enum(AOP_TAG_IDS))
		.optional()
		.describe(
			"格付けタグで絞り込む(複数指定はOR)。" +
				"ブルゴーニュ/シャンパーニュ: grand-cru=特級, premier-cru=一級" +
				"(村に premier-cru が付く場合、シャンパーニュでは村自体が一級、" +
				"ブルゴーニュ等では村名AOC内に1er Cru区画があることを表す)。" +
				"ボルドー: *-cru-classe-1855 はメドック/ソーテルヌ1855年格付け" +
				"(第1〜5級・特別第1級)、premier-grand-cru-classe-a/b は" +
				"サンテミリオン第1特別級A/B。" +
				"イタリア: docg=DOCG, doc=DOC。",
		),
};

export const getAopInput = {
	aop_id: z
		.string()
		.describe("AOPのID (list_aops の id。例: 'gevrey-chambertin')"),
};

export const showAopMapInput = {
	region_id: z
		.string()
		.describe("地図を表示する地域ID (list_wine_regions の id)"),
	grape_variety_id: z
		.string()
		.optional()
		.describe(
			"ブドウ品種ID。指定するとその品種が許可されたAOPをハイライトした地図になる。",
		),
	aop_id: z.string().optional().describe("最初に選択状態にするAOPのID"),
};

// 飲んだワイン(マイセラー)の書き込みツール入力。バリデーション本体は
// Webのserver fnと共通の drunkWineFields を再利用し、MCP向けの
// snake_case キーと日本語 describe だけをここで与える。
export const registerDrunkWineInput = {
	name: drunkWineFields.name.describe("ワイン名(ラベル表記。必須)"),
	drank_on: drunkWineFields.drankOn.describe("飲んだ日 (YYYY-MM-DD)"),
	aop_id: drunkWineFields.aopId.describe(
		"紐付けるAOPのID (list_aopsのid。任意)",
	),
	rating: drunkWineFields.rating.describe("評価 (1〜5の整数)"),
	memo: drunkWineFields.memo.describe("メモ・感想 (2000文字まで)"),
	vintage: drunkWineFields.vintage.describe("ヴィンテージ (1800〜2100の年)"),
	grape_variety_ids: drunkWineFields.grapeVarietyIds.describe(
		"ぶどう品種ID (list_grape_varietiesのid。最大20件)",
	),
	producer: drunkWineFields.producer.describe("生産者名 (200文字まで)"),
	price: drunkWineFields.price.describe("価格 (円)"),
	photo_base64: z
		.string()
		.max(7_100_000)
		.optional()
		.describe("ボトル写真のbase64。デコード後5MBまで"),
	photo_mime_type: z
		.enum(["image/jpeg", "image/png", "image/webp", "image/gif"])
		.optional()
		.describe("写真のMIMEタイプ (photo_base64 指定時は必須)"),
};

// 更新は id のみ必須。未指定フィールドは変更しない(MCPではnullクリアは扱わない)。
export const updateDrunkWineInput = {
	id: z
		.string()
		.min(1)
		.max(80)
		.describe(
			"更新するエントリのID (register_drunk_wine / list_drunk_wines の entry.id)",
		),
	...registerDrunkWineInput,
	name: drunkWineFields.name.optional().describe("ワイン名(ラベル表記)"),
};
