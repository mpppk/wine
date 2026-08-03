import { describe, expect, it } from "vitest";
import { LABEL_JSON_SCHEMA, parseLabelResponse } from "./label-extraction";
import {
	buildGptLabelInput,
	buildGptLabelTextFormat,
	countGptWebSearches,
	extractGptLabelText,
	GPT_LABEL_SCHEMA_NAME,
	toGptUsage,
} from "./label-gpt-research";

describe("buildGptLabelInput", () => {
	it("指示文と全画像を1つのuserメッセージに載せる", () => {
		const input = buildGptLabelInput([
			"data:image/jpeg;base64,AAAA",
			"data:image/png;base64,BBBB",
		]);
		expect(input).toHaveLength(1);
		const message = input[0] as { role: string; content: unknown[] };
		expect(message.role).toBe("user");
		expect(message.content).toHaveLength(3);
		expect(message.content[0]).toMatchObject({ type: "input_text" });
		expect(message.content[1]).toEqual({
			type: "input_image",
			image_url: "data:image/jpeg;base64,AAAA",
			detail: "auto",
		});
		expect(message.content[2]).toEqual({
			type: "input_image",
			image_url: "data:image/png;base64,BBBB",
			detail: "auto",
		});
	});

	it("data URI 以外(HTTP URL)は弾く", () => {
		// image_url は素の URL も受け付けてしまうため、境界で data URI を強制する
		expect(() => buildGptLabelInput(["https://example.com/a.jpg"])).toThrow();
		expect(() => buildGptLabelInput(["data:image/jpeg,notbase64"])).toThrow();
	});
});

describe("buildGptLabelTextFormat", () => {
	it("Workers AI 経路と同じ出力スキーマを strict で強制する", () => {
		const format = buildGptLabelTextFormat().format;
		expect(format).toMatchObject({
			type: "json_schema",
			name: GPT_LABEL_SCHEMA_NAME,
			strict: true,
		});
		// 出力フィールドの SSOT は LABEL_JSON_SCHEMA(経路ごとに書き分けない)
		expect((format as { schema: unknown }).schema).toBe(LABEL_JSON_SCHEMA);
	});

	it("スキーマ名は structured outputs の命名制約(a-zA-Z0-9_-, 64文字以内)を満たす", () => {
		expect(GPT_LABEL_SCHEMA_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
	});
});

describe("extractGptLabelText", () => {
	it("完了した応答の本文をそのまま返し、parseLabelResponse で解釈できる", () => {
		const text = extractGptLabelText({
			status: "completed",
			output_text:
				'{"wine_name":"Les Clos","producer":"Dauvissat","vintage":2020,"appellation":"Chablis Grand Cru","region":"Bourgogne","grape_varieties":["Chardonnay"]}',
			output: [],
		});
		expect(parseLabelResponse(text)).toEqual({
			wineName: "Les Clos",
			producer: "Dauvissat",
			vintage: 2020,
			appellation: "Chablis Grand Cru",
			region: "Bourgogne",
			grapeVarieties: ["Chardonnay"],
		});
	});

	it("打ち切られた応答(incomplete)は理由つきでthrowする", () => {
		// 空文字を返すと「JSONが含まれていない」という無関係な例外になり、
		// web検索/reasoning が出力枠を食い切ったことが後から追えなくなる
		expect(() =>
			extractGptLabelText({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output_text: "",
				output: [],
			}),
		).toThrow("max_output_tokens");
	});

	it("理由が無い incomplete でもthrowする", () => {
		expect(() =>
			extractGptLabelText({ status: "incomplete", output: [] }),
		).toThrow();
	});

	it("refusal ブロックはthrowする(structured outputsでもスキーマに従わない)", () => {
		expect(() =>
			extractGptLabelText({
				status: "completed",
				output_text: "",
				output: [
					{
						type: "message",
						content: [{ type: "refusal", refusal: "できません" }],
					},
				],
			}),
		).toThrow("できません");
	});

	it("content を持たない output 要素(ツール呼び出し・reasoning)は素通しする", () => {
		const text = extractGptLabelText({
			status: "completed",
			output_text: "{}",
			output: [
				{ type: "web_search_call", status: "completed" },
				{ type: "reasoning", summary: [] },
				{ type: "message", content: [{ type: "output_text", text: "{}" }] },
			],
		});
		expect(text).toBe("{}");
	});
});

describe("countGptWebSearches", () => {
	// web検索の回数は usage に出ないので output から数えるしかない。$10/1000回 の
	// 回数課金で Luna の原価の8割を占めるため、ここを落とすと原価がほぼ見えなくなる。
	it("web_search_call アイテムを数える", () => {
		expect(
			countGptWebSearches([
				{ type: "reasoning" },
				{ type: "web_search_call" },
				{ type: "web_search_call" },
				{ type: "message" },
			]),
		).toBe(2);
	});

	it("検索が無ければ0", () => {
		expect(countGptWebSearches([{ type: "message" }])).toBe(0);
		expect(countGptWebSearches(undefined)).toBe(0);
	});

	it("null・非オブジェクトが混ざっても壊れない", () => {
		expect(countGptWebSearches([null, "x", { type: "web_search_call" }])).toBe(
			1,
		);
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
});
