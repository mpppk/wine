import { describe, expect, it } from "vitest";
import {
	accumulateStepUsage,
	countProviderExecutedCalls,
	toAiSdkUsage,
} from "./ai-sdk-usage";

describe("toAiSdkUsage", () => {
	it("非キャッシュ入力は noCacheTokens をそのまま使う", () => {
		expect(
			toAiSdkUsage(
				{
					inputTokens: 23_247,
					inputTokenDetails: {
						noCacheTokens: 11_022,
						cacheReadTokens: 12_225,
						cacheWriteTokens: 0,
					},
					outputTokens: 746,
				},
				{ webSearches: 2, billCacheWrites: false },
			),
		).toEqual({
			inputTokens: 11_022,
			outputTokens: 746,
			cacheReadTokens: 12_225,
			cacheWriteTokens: 0,
			webSearches: 2,
		});
	});

	it("noCacheTokens が無ければ input からキャッシュ読みを差し引く(二重計上を避ける)", () => {
		const usage = toAiSdkUsage(
			{
				inputTokens: 1_000,
				inputTokenDetails: { cacheReadTokens: 400 },
				outputTokens: 100,
			},
			{ webSearches: 0, billCacheWrites: false },
		);
		expect(usage.inputTokens).toBe(600);
		expect(usage.cacheReadTokens).toBe(400);
	});

	it("キャッシュ書き込みは呼び出し側が計上を指示したときだけ載る", () => {
		const details = {
			inputTokens: 1_000,
			inputTokenDetails: { noCacheTokens: 1_000, cacheWriteTokens: 500 },
			outputTokens: 10,
		};
		// OpenAI は書き込みを課金しないので拾わない(拾うと入力単価で過大請求になる)
		expect(
			toAiSdkUsage(details, { webSearches: 0, billCacheWrites: false })
				.cacheWriteTokens,
		).toBe(0);
		// Anthropic は課金するので拾う
		expect(
			toAiSdkUsage(details, { webSearches: 0, billCacheWrites: true })
				.cacheWriteTokens,
		).toBe(500);
	});

	it("usage が無くても検索回数は残る", () => {
		expect(
			toAiSdkUsage(undefined, { webSearches: 3, billCacheWrites: false }),
		).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			webSearches: 3,
		});
	});
});

describe("countProviderExecutedCalls", () => {
	it("指定したツール名の呼び出しだけを数える", () => {
		expect(
			countProviderExecutedCalls(
				[
					{ toolName: "web_search" },
					{ toolName: "search_appellation" },
					{ toolName: "web_search" },
				],
				"web_search",
			),
		).toBe(2);
	});

	it("null・非オブジェクトが混ざっても壊れない", () => {
		expect(
			countProviderExecutedCalls(
				[null, "x", { toolName: "web_search" }],
				"web_search",
			),
		).toBe(1);
		expect(countProviderExecutedCalls(undefined, "web_search")).toBe(0);
	});
});

describe("accumulateStepUsage", () => {
	// ループを止めるかどうかは generateText が戻る前に決めないといけないので、
	// ステップ列から自前で原価を積む。
	const steps = [
		{
			usage: {
				inputTokens: 10_000,
				inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0 },
				outputTokens: 500,
			},
			toolCalls: [
				{ toolName: "web_search" },
				{ toolName: "search_appellation" },
			],
		},
		{
			usage: {
				inputTokens: 16_000,
				inputTokenDetails: { noCacheTokens: 4_000, cacheReadTokens: 12_000 },
				outputTokens: 300,
			},
			toolCalls: [{ toolName: "web_search" }, { toolName: "web_search" }],
		},
	];

	it("ステップをまたいでトークンと検索回数を合算する", () => {
		expect(
			accumulateStepUsage(steps, {
				webSearches: 0,
				billCacheWrites: false,
				webSearchToolName: "web_search",
			}),
		).toEqual({
			inputTokens: 14_000,
			outputTokens: 800,
			cacheReadTokens: 12_000,
			cacheWriteTokens: 0,
			// 自前ツール(search_appellation)は回数課金の対象外
			webSearches: 3,
		});
	});

	it("ステップが無ければ全て0(ループ開始前に判定しても壊れない)", () => {
		expect(
			accumulateStepUsage([], {
				webSearches: 0,
				billCacheWrites: false,
				webSearchToolName: "web_search",
			}),
		).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			webSearches: 0,
		});
	});
});
