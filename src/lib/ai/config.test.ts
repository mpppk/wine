import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_MICRO_USD } from "#/lib/billing/ai-pricing";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { costToCredits } from "#/lib/credit/credit-math";
import {
	AI_HISTORY_CONTENT_MAX_CHARS,
	AI_HISTORY_INPUT_MAX_MESSAGES,
	AI_LABEL_ENGINES,
	AI_MAX_HISTORY_MESSAGES,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_MAX_SEARCHES,
	chatHistorySchema,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REGION_QA_MODEL,
	estimateLabelReserveCharge,
	estimateLabelReserveUsage,
	estimateRegionQaReserveCharge,
	estimateWineListReserveUsage,
	LABEL_ENGINE_KEYS,
	type LabelRoute,
	labelEngineKeySchema,
	REGION_QA_MODEL_KEYS,
	regionQaModelKeySchema,
	resolveLabelRoute,
	toLabelEngineKey,
	toRegionQaModelKey,
	WINE_LIST_ROUTE_KEYS,
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

// 選択されたエンジンと実際に走る経路の対応づけ。ai-service が経路ごとに
// `!!key && engine === "..."` を書くと、経路が増えるたびに条件がドリフトして
// 「片方のキーだけ設定された環境で黙って標準へ落ちる」が起きるため、ここが SSOT。
describe("resolveLabelRoute", () => {
	const both = { openai: true, anthropic: true };
	const neither = { openai: false, anthropic: false };
	const onlyOpenai = { openai: true, anthropic: false };
	const onlyAnthropic = { openai: false, anthropic: true };

	it("キーが揃っていれば選択どおりの経路になる", () => {
		expect(resolveLabelRoute("gpt-luna", both)).toBe("gpt-luna");
		expect(resolveLabelRoute("web-research", both)).toBe("web-research");
	});

	it("標準(workers-ai)の明示選択はキー設定時でも高精度に上がらない", () => {
		expect(resolveLabelRoute("workers-ai", both)).toBe("workers-ai");
		expect(resolveLabelRoute("workers-ai", neither)).toBe("workers-ai");
	});

	it("選んだプロバイダのキーが無ければ、標準へ落とす前にもう一方の高精度を使う", () => {
		// 既定が gpt-luna でも、ANTHROPIC_API_KEY だけの環境が Workers AI へ
		// 降格しない(#354 時点の本番構成に対する回帰テスト)
		expect(resolveLabelRoute("gpt-luna", onlyAnthropic)).toBe("web-research");
		expect(resolveLabelRoute("web-research", onlyOpenai)).toBe("gpt-luna");
	});

	it("高精度のキーが1つも無ければ標準へ降格する", () => {
		expect(resolveLabelRoute("gpt-luna", neither)).toBe("workers-ai");
		expect(resolveLabelRoute("web-research", neither)).toBe("workers-ai");
	});

	it("既定エンジンはどのキー構成でも必ず解決先を持つ", () => {
		for (const availability of [both, neither, onlyOpenai, onlyAnthropic]) {
			expect(LABEL_ENGINE_KEYS).toContain(
				resolveLabelRoute(DEFAULT_LABEL_ENGINE, availability),
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

// ---- 予約見積(コスト単位) ----
// 経路ごとの中心値見積。**単価表を通した µUSD** で比較するので、「トークン数は同じでも
// 経路によって消費が2桁違う」という #355 の本質がそのまま固定される。

describe("estimateLabelReserveCharge", () => {
	const microUsd = (route: LabelRoute, photos: number) =>
		estimateLabelReserveCharge(route, photos).microUsd;

	it("枚数に比例し、0枚でも1枚ぶんを下限にする", () => {
		for (const route of LABEL_ENGINE_KEYS) {
			expect(microUsd(route, 3)).toBeGreaterThan(microUsd(route, 1));
			expect(microUsd(route, 0)).toBe(microUsd(route, 1));
		}
	});

	it("上限で必ずクランプされる", () => {
		for (const route of LABEL_ENGINE_KEYS) {
			expect(microUsd(route, 10_000)).toBe(AI_MAX_ESTIMATE_MICRO_USD);
		}
	});

	it("経路の実費差が見積に出る(標準 < Luna < Claude)", () => {
		// 転換前は3経路とも同水準のトークン見積で、消費もほぼ同じだった。
		expect(microUsd("workers-ai", 1)).toBeLessThan(microUsd("gpt-luna", 1));
		expect(microUsd("gpt-luna", 1)).toBeLessThan(microUsd("web-research", 1));
	});

	it("高精度経路は web検索の回数課金を見積に含む", () => {
		// トークンだけで見積ると、Luna は原価の8割を占める項目を落としてしまう。
		for (const route of ["gpt-luna", "web-research"] as const) {
			expect(estimateLabelReserveUsage(route, 1).webSearches).toBeGreaterThan(
				0,
			);
		}
		expect(
			estimateLabelReserveUsage("workers-ai", 1).webSearches,
		).toBeUndefined();
	});

	it("標準経路は無料会員の月次付与で複数回使える", () => {
		// 「高精度が高くて使えない」ときの逃げ道なので、ここが付与額に近づくと
		// 無料会員は自動入力を実質使えなくなる。
		expect(costToCredits(microUsd("workers-ai", 1)) * 10).toBeLessThanOrEqual(
			MONTHLY_CREDITS_FREE,
		);
	});
});

describe("estimateWineListReserveUsage (#474)", () => {
	it("両経路とも web検索の回数課金を見積に含む", () => {
		// 一括抽出も裏取りするようになった(#474)。トークンだけで見積ると、web検索の
		// 回数課金($10/1000回)が丸ごと予約から漏れる。
		for (const route of WINE_LIST_ROUTE_KEYS) {
			expect(
				estimateWineListReserveUsage(route, 1).webSearches,
			).toBeGreaterThan(0);
		}
	});

	it("検索回数は枚数に比例するが、上限でクランプされる", () => {
		// 予約時に銘柄数は分からないので枚数を代理指標にしている。比例させたままだと
		// 「銘柄数 × 検索でコストが発散する」(#358 が裏取りを外した理由)に戻るので、
		// 上限が効いていることを固定する。
		for (const route of WINE_LIST_ROUTE_KEYS) {
			const one = estimateWineListReserveUsage(route, 1).webSearches ?? 0;
			const three = estimateWineListReserveUsage(route, 3).webSearches ?? 0;
			expect(three).toBeGreaterThan(one);
			expect(estimateWineListReserveUsage(route, 10_000).webSearches).toBe(
				AI_WINE_LIST_MAX_SEARCHES,
			);
		}
	});
});

describe("estimateRegionQaReserveCharge", () => {
	it("モデルの単価差が見積に出る(gemma4 < llama4)", () => {
		const promptTokens = 1_000;
		expect(
			estimateRegionQaReserveCharge("gemma4", promptTokens).microUsd,
		).toBeLessThan(
			estimateRegionQaReserveCharge("llama4", promptTokens).microUsd,
		);
	});

	it("入力が増えれば見積も増え、上限でクランプされる", () => {
		expect(
			estimateRegionQaReserveCharge("gemma4", 5_000).microUsd,
		).toBeGreaterThan(estimateRegionQaReserveCharge("gemma4", 100).microUsd);
		expect(
			estimateRegionQaReserveCharge("gemma4", 10_000_000_000).microUsd,
		).toBe(AI_MAX_ESTIMATE_MICRO_USD);
	});
});
