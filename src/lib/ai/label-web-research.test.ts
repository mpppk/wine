import { describe, expect, it } from "vitest";
import { parseLabelResponse } from "./label-extraction";
import {
	buildWebLabelMessages,
	joinResponseText,
	toAnthropicUsage,
} from "./label-web-research";

// buildWebLabelPrompt / parseImageDataUrl は GPT経路と共有するため label-extraction.ts に
// あり、そちらのテストで検証する。

describe("buildWebLabelMessages", () => {
	it("指示文と全画像を1つのuserメッセージに載せる", () => {
		const messages = buildWebLabelMessages([
			"data:image/jpeg;base64,AAAA",
			"data:image/png;base64,BBBB",
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		const content = messages[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		if (!Array.isArray(content)) throw new Error("unreachable");
		expect(content).toHaveLength(3);
		expect(content[0]).toMatchObject({ type: "text" });
		expect(content[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
		});
		expect(content[2]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "BBBB" },
		});
	});
});

describe("joinResponseText", () => {
	it("textブロックだけを連結し、thinking・ツール結果ブロックは無視する", () => {
		const text = joinResponseText([
			{ type: "thinking", text: undefined },
			{ type: "web_search_tool_result" },
			{ type: "text", text: "調査の結果、" },
			{ type: "text", text: '{"wine_name":"Chablis"}' },
		]);
		expect(text).toBe('調査の結果、\n{"wine_name":"Chablis"}');
	});

	it("連結結果を parseLabelResponse でそのまま解釈できる", () => {
		const text = joinResponseText([
			{ type: "text", text: "以下が最終結果です。" },
			{
				type: "text",
				text: '{"wine_name":"Les Clos","producer":"Dauvissat","vintage":2020,"appellation":"Chablis Grand Cru","region":"Bourgogne","grape_varieties":["Chardonnay"]}',
			},
		]);
		expect(parseLabelResponse(text)).toEqual({
			wineName: "Les Clos",
			producer: "Dauvissat",
			vintage: 2020,
			appellation: "Chablis Grand Cru",
			region: "Bourgogne",
			grapeVarieties: ["Chardonnay"],
		});
	});
});

describe("toAnthropicUsage", () => {
	it("入力・出力・キャッシュを畳まずに分けて返す", () => {
		// 合算すると原価が復元できない(出力単価は入力の5倍、キャッシュ読みは 1/10)。
		expect(
			toAnthropicUsage({
				input_tokens: 100,
				output_tokens: 20,
				cache_creation_input_tokens: 30,
				cache_read_input_tokens: 50,
			}),
		).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheWriteTokens: 30,
			cacheReadTokens: 50,
			webSearches: 0,
		});
	});

	it("web検索の実行回数を server_tool_use から取る", () => {
		// $10/1000回 の回数課金。転換前はこのフィールドをどこも読んでおらず、
		// Claude 経路の原価の2割が計上から漏れていた(#355)。
		expect(
			toAnthropicUsage({
				input_tokens: 1,
				server_tool_use: { web_search_requests: 4 },
			}).webSearches,
		).toBe(4);
	});

	it("欠けているフィールドは0として扱う", () => {
		expect(toAnthropicUsage({ input_tokens: 10, output_tokens: null })).toEqual(
			{
				inputTokens: 10,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				webSearches: 0,
			},
		);
	});
});
