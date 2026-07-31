import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import { parseLabelResponse } from "./label-extraction";
import {
	buildWebLabelMessages,
	buildWebLabelPrompt,
	estimateWebLabelReserveTokens,
	joinResponseText,
	parseImageDataUrl,
	sumAnthropicUsage,
} from "./label-web-research";

describe("parseImageDataUrl", () => {
	it("data URI を media type と base64 データに分解する", () => {
		expect(parseImageDataUrl("data:image/jpeg;base64,AAAA")).toEqual({
			mediaType: "image/jpeg",
			data: "AAAA",
		});
		expect(parseImageDataUrl("data:image/webp;base64,x+/=")).toEqual({
			mediaType: "image/webp",
			data: "x+/=",
		});
	});

	it("base64 の data URI 以外は受け付けない", () => {
		expect(() => parseImageDataUrl("https://example.com/a.jpg")).toThrow();
		expect(() => parseImageDataUrl("data:image/jpeg,notbase64")).toThrow();
		expect(() => parseImageDataUrl("data:image/jpeg;base64,")).toThrow();
	});
});

describe("buildWebLabelPrompt", () => {
	it("web検索での裏取りとJSON出力を指示する", () => {
		const prompt = buildWebLabelPrompt();
		expect(prompt).toContain("web検索");
		expect(prompt).toContain("wine_name");
		expect(prompt).toContain("grape_varieties");
	});

	it("マスタの呼称・品種名の一覧を同梱する(照合ヒット率のグラウンディング)", () => {
		const prompt = buildWebLabelPrompt();
		// AOPマスタの正式名(aops.json 由来)
		expect(prompt).toContain("Brouilly");
		expect(prompt).toContain("Chablis");
		// 品種マスタの現地語名(varieties.ts 由来)
		expect(prompt).toContain("Pinot noir");
		expect(prompt).toContain("Chardonnay");
	});
});

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

describe("sumAnthropicUsage", () => {
	it("入力(キャッシュ含む)+出力を合算する", () => {
		expect(
			sumAnthropicUsage({
				input_tokens: 100,
				output_tokens: 20,
				cache_creation_input_tokens: 30,
				cache_read_input_tokens: 50,
			}),
		).toBe(200);
	});

	it("欠けているフィールドは0として扱う", () => {
		expect(sumAnthropicUsage({ input_tokens: 10, output_tokens: null })).toBe(
			10,
		);
		expect(sumAnthropicUsage({})).toBe(0);
	});
});

describe("estimateWebLabelReserveTokens", () => {
	it("枚数に比例して増え、0枚でも1枚ぶんを下限にする", () => {
		const one = estimateWebLabelReserveTokens(1);
		const three = estimateWebLabelReserveTokens(3);
		expect(three).toBeGreaterThan(one);
		expect(estimateWebLabelReserveTokens(0)).toBe(one);
	});

	it("上限で必ずクランプされる", () => {
		expect(estimateWebLabelReserveTokens(1000)).toBe(AI_MAX_ESTIMATE_TOKENS);
	});
});
