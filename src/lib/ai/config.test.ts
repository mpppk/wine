import { describe, expect, it } from "vitest";
import {
	AI_REGION_QA_MODELS,
	DEFAULT_REGION_QA_MODEL,
	REGION_QA_MODEL_KEYS,
} from "./config";

// 地域Q&Aモデルの許可リスト定義の健全性。キー⇄定義の対応と既定キーの妥当性を保証する。
describe("AI_REGION_QA_MODELS", () => {
	it("REGION_QA_MODEL_KEYS の全キーに定義がある", () => {
		for (const key of REGION_QA_MODEL_KEYS) {
			const model = AI_REGION_QA_MODELS[key];
			expect(model).toBeDefined();
			expect(model.id).toMatch(/^@cf\//);
			expect(model.label.length).toBeGreaterThan(0);
		}
	});

	it("既定モデルは許可リストに含まれる", () => {
		expect(REGION_QA_MODEL_KEYS).toContain(DEFAULT_REGION_QA_MODEL);
	});

	it("Gemma 4 は thinking 無効化オプションを持ち、Llama 4 は持たない", () => {
		expect(AI_REGION_QA_MODELS.gemma4.extraOptions).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
		expect(AI_REGION_QA_MODELS.llama4.extraOptions).toBeUndefined();
	});
});
