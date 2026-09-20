import { describe, expect, it } from "vitest";
import {
	AI_LABEL_ROUTE_MODELS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_ROUTE_MODELS,
} from "#/lib/ai/config";
import { toOpenRouterUsage } from "#/lib/ai/openrouter";
import {
	type AiUsage,
	getModelPricing,
	usageToMicroUsd,
} from "#/lib/billing/ai-pricing";

// **会計の取りこぼし検知**(#355 / #404 の再発防止)。
//
// この機能群の原価は 入力 / 出力 / キャッシュ読み / キャッシュ書き / web検索の回数 に
// 分かれており、合計トークンからは復元できない。過去に実際に壊れたのは個々の換算式
// ではなく「**プロバイダは返しているのに、こちらのマッパーが拾っていない**」という
// 欠落で、web検索の回数課金($10/1000回。Luna では原価の大半)がまったく計上されて
// いなかった。この形の欠落は typecheck も既存の単体テストも検出しない —— 数字が
// 小さくなるだけで、成功した推論として素通りするため。
//
// ここでは経路ごとに「**プロバイダの実応答 → マッパー → AiUsage**」を通し、
//
//   1. 単価表が課金する項目を、マッパーが実際に埋めていること
//   2. その項目を落とすと原価が**下がる**こと(= 本当に課金に効いていること)
//   3. 課金対象として宣言していない項目を、マッパーが黙って埋め始めていないこと
//
// を検査する。1 だけだと「埋めているが単価表が課金しない(死んだ計上)」を見逃し、
// 2 だけだと「単価表は課金するがマッパーが埋めない(取りこぼし)」を見逃す。
//
// 経路を足したときに検査の対象から漏れないよう、末尾で
// **全モデルがこの表に載っていること**も検証する。

/** 会計に効きうる usage の項目。 */
type BilledComponent = keyof Pick<
	AiUsage,
	| "inputTokens"
	| "outputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "webSearches"
>;

const ALL_COMPONENTS: readonly BilledComponent[] = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"webSearches",
];

interface RouteAccounting {
	/** 失敗時に経路が分かる表示名。 */
	name: string;
	/** 実際に課金するモデルID(単価表を引くキー)。 */
	model: string;
	/** プロバイダの実応答をマッパーへ通した結果。 */
	usage: AiUsage;
	/**
	 * この経路で**課金対象になる項目**。ここに挙げた項目は「マッパーが埋める」かつ
	 * 「単価表が課金する」の両方を満たす必要がある。挙げていない項目が埋まっていても失敗する。
	 */
	billed: readonly BilledComponent[];
}

/**
 * #602 で全経路を OpenRouter の chat completions へ集約した。usage は OpenRouter が
 * 正規化した共通形で返る。トークン数は旧・直接接続時代の実応答から採った値
 * (scripts/spike-label-usage.ts)。web検索の回数は応答の
 * `usage.server_tool_use.web_search_requests` に出る(旧 GPT 経路のように
 * ツール呼び出しを数える必要は無い)。
 */
const OR_AGENT_LOOP_USAGE = {
	prompt_tokens: 23_247,
	completion_tokens: 746,
	prompt_tokens_details: { cached_tokens: 12_225 },
	completion_tokens_details: { reasoning_tokens: 400 },
	server_tool_use: { web_search_requests: 2 },
} as const;

/**
 * Claude経路。`server_tool_use.web_search_requests` に web検索の回数が載る。
 * プロンプトキャッシュの書き込みはこちらからは使わない(cache_control を付けない)
 * ので、書き込みトークンが来ても計上しない(下の専用テスト参照)。
 */
const OR_CLAUDE_RAW_USAGE = {
	prompt_tokens: 18_400,
	completion_tokens: 2_100,
	prompt_tokens_details: { cached_tokens: 11_800 },
	cache_creation_input_tokens: 6_200,
	server_tool_use: { web_search_requests: 6 },
} as const;

/** 単発の構造化抽出(web検索なし)。 */
const OR_SINGLE_SHOT_USAGE = {
	prompt_tokens: 11_500,
	completion_tokens: 320,
	prompt_tokens_details: { cached_tokens: 0 },
} as const;

/** 地域Q&A。短文回答で web検索は使わない。 */
const OR_REGION_QA_USAGE = {
	prompt_tokens: 1_200,
	completion_tokens: 65,
	prompt_tokens_details: { cached_tokens: 800 },
} as const;

const ROUTE_ACCOUNTING: readonly RouteAccounting[] = [
	{
		name: "エチケット解析 / gpt-luna",
		model: AI_LABEL_ROUTE_MODELS["gpt-luna"],
		usage: toOpenRouterUsage(OR_AGENT_LOOP_USAGE),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens", "webSearches"],
	},
	{
		name: "エチケット解析 / web-research",
		model: AI_LABEL_ROUTE_MODELS["web-research"],
		usage: toOpenRouterUsage(OR_CLAUDE_RAW_USAGE),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens", "webSearches"],
	},
	{
		name: "エチケット解析 / standard",
		model: AI_LABEL_ROUTE_MODELS.standard,
		usage: toOpenRouterUsage(OR_SINGLE_SHOT_USAGE),
		billed: ["inputTokens", "outputTokens"],
	},
	{
		name: "一括抽出 / gpt-luna",
		model: AI_WINE_LIST_ROUTE_MODELS["gpt-luna"],
		usage: toOpenRouterUsage({
			...OR_AGENT_LOOP_USAGE,
			server_tool_use: { web_search_requests: 4 },
		}),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens", "webSearches"],
	},
	{
		name: "一括抽出 / web-research",
		model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
		usage: toOpenRouterUsage({
			...OR_CLAUDE_RAW_USAGE,
			server_tool_use: { web_search_requests: 4 },
		}),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens", "webSearches"],
	},
	{
		name: "地域Q&A / gemma4",
		model: AI_REGION_QA_MODELS.gemma4.id,
		usage: toOpenRouterUsage(OR_REGION_QA_USAGE),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens"],
	},
	{
		name: "地域Q&A / llama4",
		model: AI_REGION_QA_MODELS.llama4.id,
		usage: toOpenRouterUsage(OR_REGION_QA_USAGE),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens"],
	},
];

describe("経路ごとの会計の取りこぼし検知", () => {
	for (const route of ROUTE_ACCOUNTING) {
		describe(route.name, () => {
			it("課金対象の項目をマッパーが埋めている", () => {
				for (const component of route.billed) {
					expect(
						route.usage[component] ?? 0,
						`${route.name}: ${component} が計上されていない(プロバイダの応答から拾い漏れている)`,
					).toBeGreaterThan(0);
				}
			});

			it("課金対象の項目を落とすと原価が下がる(死んだ計上でない)", () => {
				const full = usageToMicroUsd(route.model, route.usage);
				for (const component of route.billed) {
					const without = usageToMicroUsd(route.model, {
						...route.usage,
						[component]: 0,
					});
					expect(
						without,
						`${route.name}: ${component} を 0 にしても原価が変わらない(単価表が課金していない)`,
					).toBeLessThan(full);
				}
			});

			it("宣言していない項目を黙って計上し始めていない", () => {
				const undeclared = ALL_COMPONENTS.filter(
					(c) => !route.billed.includes(c),
				);
				for (const component of undeclared) {
					expect(
						route.usage[component] ?? 0,
						`${route.name}: ${component} が計上されているが課金対象として宣言されていない。意図した変更なら billed に追加すること`,
					).toBe(0);
				}
			});
		});
	}

	it("課金するモデルがすべて検査対象になっている", () => {
		const covered = new Set(ROUTE_ACCOUNTING.map((r) => r.model));
		const billedModels = [
			...Object.values(AI_LABEL_ROUTE_MODELS),
			...Object.values(AI_WINE_LIST_ROUTE_MODELS),
			...Object.values(AI_REGION_QA_MODELS).map((m) => m.id),
		];
		for (const model of billedModels) {
			expect(
				covered,
				`${model} で課金しているのに会計の検査対象になっていない`,
			).toContain(model);
		}
	});
});

describe("OpenRouter経路のキャッシュ書き込み", () => {
	// プロンプトキャッシュの書き込みはこちらからは使わない(cache_control を付けない)。
	// 一方 usageToMicroUsd は単価未定義のキャッシュ書き込みを**入力単価**で換算する
	// (割引を勝手に仮定しない安全側の既定)。つまり cache_creation 系のトークンを
	// 計上すると、無料のトークンに入力単価が乗って過大請求になる。
	// 「マッパーが拾っていない」のは取りこぼしではなく意図した判断であることを、
	// テストとして固定しておく。
	const model = AI_LABEL_ROUTE_MODELS["gpt-luna"];

	it("単価表は OpenRouter モデルのキャッシュ書き込みに単価を持たない", () => {
		expect(getModelPricing(model)?.cacheWriteUsdPerMTok).toBeUndefined();
	});

	it("実応答に書き込みトークンがあっても計上しない", () => {
		const usage = toOpenRouterUsage({
			prompt_tokens: 25_684,
			completion_tokens: 822,
			prompt_tokens_details: { cached_tokens: 0 },
			cache_creation_input_tokens: 12_772,
		});
		expect(usage.cacheWriteTokens ?? 0).toBe(0);
	});

	it("仮に計上すると入力単価で課金され、過大請求になる", () => {
		const withoutWrite = usageToMicroUsd(model, { inputTokens: 10_000 });
		const withWrite = usageToMicroUsd(model, {
			inputTokens: 10_000,
			cacheWriteTokens: 10_000,
		});
		expect(withWrite).toBeGreaterThan(withoutWrite);
	});
});
