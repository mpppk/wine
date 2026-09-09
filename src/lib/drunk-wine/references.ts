import { z } from "zod";
import {
	LABEL_PRICES_MAX,
	LABEL_REFERENCE_LINKS_MAX,
	type LabelPrice,
	type LabelReferenceLink,
	labelPriceKey,
	normalizePrices,
	normalizeReferenceLinks,
	unionCapped,
} from "#/lib/ai/label-extraction";

// 解析の参考サイト・市場価格を銘柄に保存するときの域内SSOT。
//
// 受け取りの正規化はエチケット解析(`label-extraction`)と共有する。経路ごとに
// 書き直すと、後発の経路で適用漏れが起きる(#166 / #174 / #185 と同型)。
// 上限(各3件)・同一性キーも同じ定義を指す。
//
// DB列の追加・永続化は別PR(マイグレーション)のため、このモジュールは純ロジック
// (API境界の形・正規化・統合)のみを持つ。DBに触れない。

/** 保存する参考サイトの上限。解析の出力上限と同じ値を使う。 */
export const STORED_REFERENCE_LINKS_MAX = LABEL_REFERENCE_LINKS_MAX;

/** 保存する市場価格の上限。同上。 */
export const STORED_MARKET_PRICES_MAX = LABEL_PRICES_MAX;

/**
 * API境界で受ける参考サイト1件の形。アプリ側の表現もモデルの生出力も受ける。
 * 意味的な検証(URLの有無・http/https)は `normalizeStoredReferenceLinks` 側が
 * 行い、不正行は落とす。
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
 * 両方無ければ `normalizeStoredMarketPrices` が落とす。
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

/**
 * 参考サイトの正規化。URLが無い行・http/https でない行は落とし、同じURLの
 * 重複を潰して上限で切り捨てる。決して throw しない。
 */
export function normalizeStoredReferenceLinks(
	input: unknown,
): LabelReferenceLink[] {
	return normalizeReferenceLinks(input);
}

/**
 * 市場価格の正規化。アプリ側の表現とモデルの生出力の両対応で `amount_jpy` へ
 * 寄せてから `normalizePrices` へ渡す(円建て・外貨のどちらかが読めれば行を残す)。
 * `source` が無い行・金額が読めない行は落とす。決して throw しない。
 */
export function normalizeStoredMarketPrices(input: unknown): LabelPrice[] {
	const items = Array.isArray(input) ? input : [input];
	return normalizePrices(
		items.map((raw) => {
			if (!raw || typeof raw !== "object") return raw;
			const rec = raw as Record<string, unknown>;
			return {
				source: rec.source,
				// API境界は camelCase、モデル出力は snake_case。両対応で読む。
				amount_jpy: rec.amount_jpy ?? rec.amountJpy,
				currency: rec.currency,
				amount: rec.amount,
				url: rec.url,
			};
		}),
	);
}

/**
 * 保存済みの参考サイトへ解析結果をマージする(再解析での補充・既存一致への追加用)。
 * 同じURLは重複させず、上限で切り捨てる。どちらも空なら undefined。
 * 束ね自体は `unionCapped`(`label-extraction` のSSOT)と共有する。
 */
export function mergeStoredReferenceLinks(
	base: readonly LabelReferenceLink[] | undefined,
	added: readonly LabelReferenceLink[] | undefined,
): LabelReferenceLink[] | undefined {
	return unionCapped(base, added, (l) => l.url, STORED_REFERENCE_LINKS_MAX);
}

/**
 * 保存済みの市場価格へ解析結果をマージする。同上(キーは店+金額)。
 * どちらも空なら undefined。
 */
export function mergeStoredMarketPrices(
	base: readonly LabelPrice[] | undefined,
	added: readonly LabelPrice[] | undefined,
): LabelPrice[] | undefined {
	return unionCapped(
		base,
		added,
		(p) => labelPriceKey(p),
		STORED_MARKET_PRICES_MAX,
	);
}
