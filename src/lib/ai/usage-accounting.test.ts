import { describe, expect, it } from "vitest";
import {
	AI_LABEL_ROUTE_MODELS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_ROUTE_MODELS,
} from "#/lib/ai/config";
import { countGptWebSearches, toGptUsage } from "#/lib/ai/label-gpt-research";
import { toAnthropicUsage } from "#/lib/ai/label-web-research";
import { toWorkersAiUsage } from "#/lib/ai/workers-ai-usage";
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
 * GPT経路(エチケット解析)。トークン数は 2026-08-06 に `gpt-5.6-luna` の実応答から
 * 採った値(scripts/spike-label-usage.ts の実行結果)。web検索の回数は usage に出ない
 * ため、`output` 配列の web_search_call を数えて渡すのが現行の形。
 *
 * **`cache_write_tokens` も非ゼロにしてある**(実測ではキャッシュのヒット回とミス回で
 * 片方ずつだった)。プロバイダが返しうる項目をすべて埋めておかないと、「宣言していない
 * 項目を黙って計上し始めていない」の検査が素通りしてしまうため。前方のプレフィクスが
 * ヒットしつつ後続が新たにキャッシュされれば、実際に両方が同時に載る。
 */
const GPT_LABEL_RAW_USAGE = {
	input_tokens: 23_247,
	input_tokens_details: { cached_tokens: 12_225, cache_write_tokens: 3_100 },
	output_tokens: 746,
} as const;

const GPT_LABEL_RAW_OUTPUT = [
	{ type: "web_search_call", id: "ws_1" },
	{ type: "web_search_call", id: "ws_2" },
	{ type: "message", content: [{ type: "output_text", text: "{}" }] },
] as const;

/**
 * Claude経路。`server_tool_use.web_search_requests` に web検索の回数が載る
 * (GPT経路と違い usage の中に出る)。キャッシュは読み・書きが別項目で、単価も別。
 */
const CLAUDE_LABEL_RAW_USAGE = {
	input_tokens: 18_400,
	output_tokens: 2_100,
	cache_creation_input_tokens: 6_200,
	cache_read_input_tokens: 11_800,
	server_tool_use: { web_search_requests: 6 },
} as const;

/** Workers AI は内訳を返さず total_tokens のみ。全量を出力として計上する。 */
const WORKERS_AI_RAW_USAGE = { total_tokens: 812 } as const;

const ROUTE_ACCOUNTING: readonly RouteAccounting[] = [
	{
		name: "エチケット解析 / gpt-luna",
		model: AI_LABEL_ROUTE_MODELS["gpt-luna"],
		usage: toGptUsage(
			GPT_LABEL_RAW_USAGE,
			countGptWebSearches(GPT_LABEL_RAW_OUTPUT),
		),
		// OpenAI はキャッシュ**書き込み**を課金しないので計上しない(下の専用テスト参照)。
		billed: ["inputTokens", "outputTokens", "cacheReadTokens", "webSearches"],
	},
	{
		name: "エチケット解析 / web-research",
		model: AI_LABEL_ROUTE_MODELS["web-research"],
		usage: toAnthropicUsage(CLAUDE_LABEL_RAW_USAGE),
		billed: [
			"inputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
			"webSearches",
		],
	},
	{
		name: "エチケット解析 / workers-ai",
		model: AI_LABEL_ROUTE_MODELS["workers-ai"],
		usage: toWorkersAiUsage(WORKERS_AI_RAW_USAGE) ?? {},
		billed: ["outputTokens"],
	},
	{
		// 一括抽出は**web検索を使わない**(#358 の住み分け)ので、同じ GPT 経路でも
		// 課金対象が1つ少ない。マッパーは共有だが宣言は経路ごとに持つ。
		name: "一括抽出 / gpt-luna",
		model: AI_WINE_LIST_ROUTE_MODELS["gpt-luna"],
		usage: toGptUsage(GPT_LABEL_RAW_USAGE, 0),
		billed: ["inputTokens", "outputTokens", "cacheReadTokens"],
	},
	{
		name: "一括抽出 / web-research",
		model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
		usage: toAnthropicUsage({
			...CLAUDE_LABEL_RAW_USAGE,
			server_tool_use: { web_search_requests: 0 },
		}),
		billed: [
			"inputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		],
	},
	{
		name: "地域Q&A / gemma4",
		model: AI_REGION_QA_MODELS.gemma4.id,
		usage: toWorkersAiUsage(WORKERS_AI_RAW_USAGE) ?? {},
		billed: ["outputTokens"],
	},
	{
		name: "地域Q&A / llama4",
		model: AI_REGION_QA_MODELS.llama4.id,
		usage: toWorkersAiUsage(WORKERS_AI_RAW_USAGE) ?? {},
		billed: ["outputTokens"],
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

describe("OpenAI経路のキャッシュ書き込み", () => {
	// OpenAI は cached input の**割引**だけで書き込み側の課金が無く、単価表にも
	// cacheWriteUsdPerMTok を持たせていない。一方 usageToMicroUsd は単価未定義の
	// キャッシュ書き込みを**入力単価**で換算する(割引を勝手に仮定しない安全側の既定)。
	// つまり cache_write_tokens を計上すると、無料のトークンに入力単価が乗って過大請求になる。
	// 「マッパーが拾っていない」のは取りこぼしではなく意図した判断であることを、
	// テストとして固定しておく。
	const model = AI_LABEL_ROUTE_MODELS["gpt-luna"];

	it("単価表は OpenAI のキャッシュ書き込みに単価を持たない", () => {
		expect(getModelPricing(model)?.cacheWriteUsdPerMTok).toBeUndefined();
	});

	it("実応答に cache_write_tokens があっても計上しない(過大請求になるため)", () => {
		const usage = toGptUsage(
			{
				input_tokens: 25_684,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 12_772 },
				output_tokens: 822,
			},
			2,
		);
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
