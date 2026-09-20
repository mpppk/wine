import { describe, expect, it } from "vitest";
import { parseLabelResponse } from "./label-extraction";
import { buildWebLabelMessages } from "./label-web-research";

// buildWebLabelPrompt / parseImageDataUrl は GPT経路と共有するため label-extraction.ts に
// あり、そちらのテストで検証する。

describe("buildWebLabelMessages", () => {
	it("指示文と全画像を1つのuserメッセージに載せる(OpenAI chat形式)", () => {
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
		expect(content[0]).toEqual({
			type: "text",
			text: expect.any(String),
		});
		expect(content[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,AAAA" },
		});
		expect(content[2]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/png;base64,BBBB" },
		});
	});

	it("HTTP URLは境界で拒否する", () => {
		expect(() =>
			buildWebLabelMessages(["https://example.com/photo.jpg"]),
		).toThrow();
	});

	it("指示文を差し替えても画像の載せ方は同じ", () => {
		const messages = buildWebLabelMessages(
			["data:image/jpeg;base64,AAAA"],
			"custom prompt",
		);
		const content = messages[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		if (!Array.isArray(content)) throw new Error("unreachable");
		expect(content[0]).toEqual({ type: "text", text: "custom prompt" });
		expect(content).toHaveLength(2);
	});
});

describe("応答テキストのパース", () => {
	it("本文JSONを parseLabelResponse でそのまま解釈できる", () => {
		expect(
			parseLabelResponse(
				'{"wine_name":"Les Clos","producer":"Dauvissat","vintage":2020,"appellation":"Chablis Grand Cru","region":"Bourgogne","grape_varieties":["Chardonnay"]}',
			),
		).toEqual({
			wineName: "Les Clos",
			producer: "Dauvissat",
			vintage: 2020,
			appellation: "Chablis Grand Cru",
			region: "Bourgogne",
			grapeVarieties: ["Chardonnay"],
		});
	});
});
