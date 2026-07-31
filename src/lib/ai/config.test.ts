import { describe, expect, it } from "vitest";
import {
	AI_HISTORY_CONTENT_MAX_CHARS,
	AI_HISTORY_INPUT_MAX_MESSAGES,
	AI_LABEL_ENGINES,
	AI_MAX_HISTORY_MESSAGES,
	AI_REGION_QA_MODELS,
	chatHistorySchema,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REGION_QA_MODEL,
	LABEL_ENGINE_KEYS,
	labelEngineKeySchema,
	REGION_QA_MODEL_KEYS,
	regionQaModelKeySchema,
	toLabelEngineKey,
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

// エチケット解析エンジンの許可リスト(書き込み: auth.ts の validator / 読み取り:
// analyzeWineLabel / UI: プロフィール画面 が共有する。preferredAiModel と同じ形 #256)。
describe("labelEngineKeySchema / toLabelEngineKey", () => {
	it("LABEL_ENGINE_KEYS の全キーに表示定義があり、既定キーが含まれる", () => {
		for (const key of LABEL_ENGINE_KEYS) {
			expect(AI_LABEL_ENGINES[key]?.label.length).toBeGreaterThan(0);
			expect(labelEngineKeySchema.safeParse(key).success).toBe(true);
			expect(toLabelEngineKey(key)).toBe(key);
		}
		expect(LABEL_ENGINE_KEYS).toContain(DEFAULT_LABEL_ENGINE);
	});

	it("許可リスト外・文字列以外・巨大な文字列を拒否する", () => {
		for (const value of [
			"claude-opus-5",
			"",
			null,
			undefined,
			1,
			"a".repeat(300_000),
		]) {
			expect(toLabelEngineKey(value)).toBeNull();
		}
	});

	it("拒否時のメッセージは利用者向けの日本語(better-auth が 400 の message に載せる)", () => {
		const result = labelEngineKeySchema.safeParse("gpt-4");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe(
				"対応していない解析エンジンです。",
			);
		}
	});
});

// #340: 会話履歴の境界は Web の server fn と MCP ツールが同じ定義を import する。
// 層ごとにリテラルで書くと、片方だけ直したときに受け付ける入力が食い違い、
// ドメイン側の上限(AI_MAX_HISTORY_MESSAGES)とも非連動になる。
describe("chatHistorySchema (会話履歴の入力境界)", () => {
	function history(count: number, content = "こんにちは") {
		return Array.from({ length: count }, (_v, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content,
		}));
	}

	it("境界の上限はドメインの履歴上限を下回らない", () => {
		// 下回ると AI_MAX_HISTORY_MESSAGES を緩めても境界が先に 400 を返し、
		// 設定変更が黙って効かなくなる。
		expect(AI_HISTORY_INPUT_MAX_MESSAGES).toBeGreaterThanOrEqual(
			AI_MAX_HISTORY_MESSAGES,
		);
	});

	it("上限件数までは受け付け、超えると弾く", () => {
		expect(
			chatHistorySchema.safeParse(history(AI_HISTORY_INPUT_MAX_MESSAGES))
				.success,
		).toBe(true);
		expect(
			chatHistorySchema.safeParse(history(AI_HISTORY_INPUT_MAX_MESSAGES + 1))
				.success,
		).toBe(false);
	});

	it("1件あたりの文字数上限を超えると弾く", () => {
		const max = "あ".repeat(AI_HISTORY_CONTENT_MAX_CHARS);
		expect(chatHistorySchema.safeParse(history(2, max)).success).toBe(true);
		expect(chatHistorySchema.safeParse(history(2, `${max}あ`)).success).toBe(
			false,
		);
	});

	it("空文字・未知の role は弾く", () => {
		expect(chatHistorySchema.safeParse(history(1, "")).success).toBe(false);
		expect(
			chatHistorySchema.safeParse([{ role: "system", content: "x" }]).success,
		).toBe(false);
	});
});
