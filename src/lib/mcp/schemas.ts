import { z } from "zod";

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
	classification: z
		.enum(["regional", "village", "grand-cru"])
		.optional()
		.describe("格付けで絞り込む (地方名/村名/グラン・クリュ)"),
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
