import { describe, expect, it } from "vitest";
import {
	AI_REGION_QA_MODELS,
	DEFAULT_REGION_QA_MODEL,
	REGION_QA_MODEL_KEYS,
	regionQaModelKeySchema,
	toRegionQaModelKey,
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

// 書き込み経路(better-auth の additionalFields validator)と読み取り経路
// (resolveModelKey)、MCP ツール引数が共有する許可リスト検証(#256)。
describe("regionQaModelKeySchema / toRegionQaModelKey", () => {
	it("許可リストのキーはそのまま通る", () => {
		for (const key of REGION_QA_MODEL_KEYS) {
			expect(regionQaModelKeySchema.safeParse(key).success).toBe(true);
			expect(toRegionQaModelKey(key)).toBe(key);
		}
	});

	it("許可リスト外の文字列を拒否する", () => {
		for (const value of [
			"gpt-4",
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			"",
		]) {
			expect(regionQaModelKeySchema.safeParse(value).success).toBe(false);
			expect(toRegionQaModelKey(value)).toBeNull();
		}
	});

	it("巨大な文字列を拒否する(ストレージ肥大の防止)", () => {
		const huge = "a".repeat(300_000);
		expect(regionQaModelKeySchema.safeParse(huge).success).toBe(false);
		expect(toRegionQaModelKey(huge)).toBeNull();
	});

	it("文字列以外・未設定を拒否する", () => {
		for (const value of [null, undefined, 1, {}, ["gemma4"]]) {
			expect(toRegionQaModelKey(value)).toBeNull();
		}
	});

	it("拒否時のメッセージは利用者向けの日本語(better-auth が 400 の message に載せる)", () => {
		const result = regionQaModelKeySchema.safeParse("gpt-4");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe(
				"対応していないAIモデルです。",
			);
		}
	});
});
