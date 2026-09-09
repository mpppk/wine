import { z } from "zod";

// 解析の参考サイト・市場価格のAPI境界の形。銘柄の作成・更新・一括登録の入力が
// ここから合成する(`drunkWineReferenceInputs`)。
//
// **ランタイム依存を持たないリーフに保つ**(zod のみ)。正規化・統合は
// `references.ts` が `label-extraction` と共有するが、あちらは
// `ai/config` → `place/schema` を辿るため、ここから `label-extraction` の
// ランタイムを import すると循環してクライアントで TDZ エラーになる
// (Accessory: `place/schema.ts` は `ai/config` から参照されている)。
// 形の定義だけをここに置き、正規化は呼び出し側(`references.ts`)に任せる。

/**
 * API境界で受ける参考サイト1件の形。アプリ側の表現もモデルの生出力も受ける。
 * 意味的な検証(URLの有無・http/https)は正規化側が行い、不正行は落とす。
 */
const storedReferenceLinkItemInput = z.object({
	title: z.union([z.string(), z.number()]).nullish(),
	url: z.union([z.string(), z.number()]).nullish(),
});

/** 参考サイトの一覧入力。正規化で上限に切り詰めるので、ここでは余裕を持って受ける。 */
export const storedReferenceLinksInput = z
	.array(storedReferenceLinkItemInput)
	.max(10)
	.optional();

/**
 * API境界で受ける市場価格1件の形。アプリ側の表現(camelCase: `amountJpy`)も
 * モデルの生出力(snake_case: `amount_jpy`)も受ける。どちらかが読めれば行を残し、
 * 両方無ければ正規化が落とす。
 */
const storedMarketPriceItemInput = z.object({
	source: z.union([z.string(), z.number()]).nullish(),
	amount_jpy: z.union([z.number(), z.string()]).nullish(),
	amountJpy: z.union([z.number(), z.string()]).nullish(),
	currency: z.union([z.string(), z.number()]).nullish(),
	amount: z.union([z.number(), z.string()]).nullish(),
	url: z.union([z.string(), z.number()]).nullish(),
});

/** 市場価格の一覧入力。同上。 */
export const storedMarketPricesInput = z
	.array(storedMarketPriceItemInput)
	.max(10)
	.optional();

/**
 * 銘柄の作成・更新・一括登録の入力に足す参考情報の形。`drunkWineFields` には
 * 入れない——あちらはフォームの差分パッチ規約(`fields.ts`)と1対1で、JSON配列は
 * その規約(文字列/数値/品種IDのみ)に載らないため。参考情報は飲用・目撃記録と
 * 同じく「銘柄に添える別入力」として合成する(`place/schema.ts`、
 * `server/drunk-wine.ts`、`import-batch/schema.ts` がここを参照する)。
 */
export const drunkWineReferenceInputs = {
	referenceLinks: storedReferenceLinksInput,
	prices: storedMarketPricesInput,
};
