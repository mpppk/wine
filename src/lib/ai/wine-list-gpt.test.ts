import { describe, expect, it } from "vitest";
import {
	countGptWebSearchCalls,
	findGptRefusal,
	toGptUsage,
} from "./wine-list-gpt";

// 一括抽出の GPT 経路は**生の Responses API を直接叩く**(エチケット解析は #455 の実測を
// 受けて AI SDK へ移行済み)。応答の形が違うので、refusal の判定と usage の変換も
// こちら側に置いてある。

describe("findGptRefusal", () => {
	it("入れ子の refusal ブロックの説明文を返す", () => {
		expect(
			findGptRefusal([
				{ type: "reasoning", summary: [] },
				{
					type: "message",
					content: [{ type: "refusal", refusal: "できません" }],
				},
			]),
		).toBe("できません");
	});

	it("refusal が無ければ undefined", () => {
		expect(
			findGptRefusal([
				{ type: "message", content: [{ type: "output_text", text: "{}" }] },
			]),
		).toBeUndefined();
		expect(findGptRefusal(undefined)).toBeUndefined();
	});

	it("content を持たない要素(ツール呼び出し・reasoning)が混ざっても壊れない", () => {
		expect(
			findGptRefusal([
				null,
				"x",
				{ type: "web_search_call" },
				{ type: "message" },
			]),
		).toBeUndefined();
	});
});

describe("countGptWebSearchCalls (#474)", () => {
	it("web_search_call の件数を数える", () => {
		expect(
			countGptWebSearchCalls([
				{ type: "reasoning", summary: [] },
				{ type: "web_search_call", status: "completed" },
				{ type: "web_search_call", status: "completed" },
				{ type: "message", content: [{ type: "output_text", text: "{}" }] },
			]),
		).toBe(2);
	});

	it("検索が無ければ 0", () => {
		expect(countGptWebSearchCalls([{ type: "message" }])).toBe(0);
		expect(countGptWebSearchCalls([])).toBe(0);
		expect(countGptWebSearchCalls(undefined)).toBe(0);
	});

	it("想定外の要素が混ざっても壊れない", () => {
		expect(countGptWebSearchCalls([null, "x", 1, { type: null }])).toBe(0);
	});
});

describe("toGptUsage", () => {
	it("キャッシュヒットを input の内数から外へ出す(二重計上を避ける)", () => {
		expect(
			toGptUsage(
				{
					input_tokens: 1_000,
					output_tokens: 200,
					input_tokens_details: { cached_tokens: 400 },
				},
				3,
			),
		).toEqual({
			inputTokens: 600,
			outputTokens: 200,
			cacheReadTokens: 400,
			webSearches: 3,
		});
	});

	it("usage が無くても検索回数は残る", () => {
		expect(toGptUsage(undefined, 2)).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			webSearches: 2,
		});
	});

	it("cache_write_tokens は計上しない(OpenAIは課金せず、拾うと過大請求になる)", () => {
		const usage = toGptUsage(
			{
				input_tokens: 1_000,
				output_tokens: 200,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 500 },
			},
			0,
		);
		expect(usage.cacheWriteTokens ?? 0).toBe(0);
	});
});
