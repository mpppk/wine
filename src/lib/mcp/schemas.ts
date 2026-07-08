import { z } from "zod";
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
			"格付けタグで絞り込む(複数指定はOR)。grand-cru=特級, premier-cru=一級, " +
				"docg=イタリアDOCG, doc=イタリアDOC。" +
				"村に premier-cru が付く場合、シャンパーニュでは村自体が一級、" +
				"ブルゴーニュ等では村名AOC内に1er Cru区画があることを表す。",
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
