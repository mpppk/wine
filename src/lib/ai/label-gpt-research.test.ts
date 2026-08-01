import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import { LABEL_JSON_SCHEMA, parseLabelResponse } from "./label-extraction";
import {
	buildGptLabelInput,
	buildGptLabelTextFormat,
	estimateGptLabelReserveTokens,
	extractGptLabelText,
	GPT_LABEL_SCHEMA_NAME,
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

describe("estimateGptLabelReserveTokens", () => {
	it("枚数に比例して増え、0枚でも1枚ぶんを下限にする", () => {
		const one = estimateGptLabelReserveTokens(1);
		const three = estimateGptLabelReserveTokens(3);
		expect(three).toBeGreaterThan(one);
		expect(estimateGptLabelReserveTokens(0)).toBe(one);
	});

	it("上限で必ずクランプされる", () => {
		expect(estimateGptLabelReserveTokens(1000)).toBe(AI_MAX_ESTIMATE_TOKENS);
	});
});
