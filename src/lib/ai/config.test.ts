import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_MICRO_USD } from "#/lib/billing/ai-pricing";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { costToCredits } from "#/lib/credit/credit-math";
import {
	AI_HISTORY_CONTENT_MAX_CHARS,
	AI_HISTORY_INPUT_MAX_MESSAGES,
	AI_LABEL_ENGINES,
	AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
	AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
	AI_MAX_HISTORY_MESSAGES,
	AI_REASONING_EFFORTS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_MAX_SEARCHES,
	anthropicReasoningForEffort,
	chatHistorySchema,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REASONING_EFFORT,
	DEFAULT_REGION_QA_MODEL,
	estimateLabelReserveCharge,
	estimateLabelReserveUsage,
	estimateRegionQaReserveCharge,
	estimateWineListReserveUsage,
	LABEL_ENGINE_KEYS,
	type LabelRoute,
	labelEngineKeySchema,
	REASONING_EFFORT_KEYS,
	REGION_QA_MODEL_KEYS,
	type ReasoningEffortKey,
	reasoningEffortKeySchema,
	regionQaModelKeySchema,
	resolveLabelRoute,
	resolveWineListRoute,
	toLabelEngineKey,
	toLabelEngineKeyWithCompat,
	toReasoningEffortKey,
	toRegionQaModelKey,
	WINE_LIST_ROUTE_KEYS,
} from "./config";

// 地域Q&Aモデルの許可リスト定義の健全性。キー⇄定義の対応と既定キーの妥当性を保証する。
describe("AI_REGION_QA_MODELS", () => {
	it("REGION_QA_MODEL_KEYS の全キーに定義がある", () => {
		for (const key of REGION_QA_MODEL_KEYS) {
			const model = AI_REGION_QA_MODELS[key];
			expect(model).toBeDefined();
			// OpenRouter のモデルID(プロバイダ/モデル)。直接接続の @cf 形式ではない。
			expect(model.id).toMatch(/^[a-z-]+\//);
			expect(model.label.length).toBeGreaterThan(0);
		}
	});

	it("既定モデルは許可リストに含まれる", () => {
		expect(REGION_QA_MODEL_KEYS).toContain(DEFAULT_REGION_QA_MODEL);
	});

	it("Gemma 4 は thinking 無効化を持ち、Llama 4 は持たない", () => {
		expect(AI_REGION_QA_MODELS.gemma4.reasoning).toEqual({ effort: "none" });
		expect(AI_REGION_QA_MODELS.llama4.reasoning).toBeUndefined();
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
			"google/gemma-4-26b-a4b-it",
			"workers-ai",
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

// 推論の深さの許可リスト(書き込み: auth.ts の validator / 読み取り:
// ai-service の effort 解決 / UI: プロフィール画面 が共有する。
// preferredAiModel と同じ形 #256)。
describe("reasoningEffortKeySchema / toReasoningEffortKey", () => {
	it("REASONING_EFFORT_KEYS の全キーに表示定義があり、既定キーが含まれる", () => {
		for (const key of REASONING_EFFORT_KEYS) {
			expect(AI_REASONING_EFFORTS[key]?.label.length).toBeGreaterThan(0);
			expect(reasoningEffortKeySchema.safeParse(key).success).toBe(true);
			expect(toReasoningEffortKey(key)).toBe(key);
		}
		expect(REASONING_EFFORT_KEYS).toContain(DEFAULT_REASONING_EFFORT);
		expect(DEFAULT_REASONING_EFFORT).toBe("low");
	});

	it("許可リスト外・文字列以外・巨大な文字列を拒否する", () => {
		for (const value of [
			"ultra",
			"",
			null,
			undefined,
			1,
			"a".repeat(300_000),
		]) {
			expect(toReasoningEffortKey(value)).toBeNull();
		}
	});

	it("拒否時のメッセージは利用者向けの日本語(better-auth が 400 の message に載せる)", () => {
		const result = reasoningEffortKeySchema.safeParse("ultra");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe(
				"対応していない推論の深さです。",
			);
		}
	});
});

// effort → OpenRouter reasoning の対応づけ。budget は max_tokens 未満でなければならず、
// ラベル(16k)・一括(20k)のどちらの上限でも収まる値を固定する。
describe("anthropicReasoningForEffort", () => {
	it("low は reasoning 無指定(現行挙動のまま)", () => {
		expect(anthropicReasoningForEffort("low")).toBeUndefined();
	});

	it("medium/high は max_tokens 付きで返し、どちらの Claude 上限にも収まる", () => {
		for (const effort of ["medium", "high"] as const) {
			const reasoning = anthropicReasoningForEffort(effort);
			expect(reasoning?.max_tokens).toBeGreaterThanOrEqual(1024);
			expect(reasoning?.max_tokens).toBeLessThan(
				AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
			);
			expect(reasoning?.max_tokens).toBeLessThan(
				AI_WINE_LIST_MAX_OUTPUT_TOKENS,
			);
		}
	});

	it("high の budget は medium 以上(深さの順序が逆転しない)", () => {
		expect(
			anthropicReasoningForEffort("high")?.max_tokens,
		).toBeGreaterThanOrEqual(
			anthropicReasoningForEffort("medium")?.max_tokens ?? 0,
		);
	});
});

// GPT経路の出力上限。reasoning も同じ枠から出るため、effort 可変化に伴い緩和した。
describe("GPT max_output_tokens", () => {
	it("エチケットGPTは Claude 上限と同水準以上を確保する", () => {
		expect(AI_LABEL_GPT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(
			AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
		);
	});

	it("一括GPTは銘柄数に比例するぶん Claude 用より大きい", () => {
		expect(AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS).toBeGreaterThan(
			AI_WINE_LIST_MAX_OUTPUT_TOKENS,
		);
	});
});

// effort別の出力見積の倍率。深く考えさせるほど reasoning が出力枠を食うため、
// 高精度経路の出力中心値を引き上げる。Workers AI 経路は reasoning を使わないので不変。
describe("estimate reserve usage の effort 倍率", () => {
	it("高精度経路は medium/high で出力見積が増える(low 順)", () => {
		const low = estimateLabelReserveUsage("gpt-luna", 1, "low").outputTokens;
		const medium = estimateLabelReserveUsage(
			"gpt-luna",
			1,
			"medium",
		).outputTokens;
		const high = estimateLabelReserveUsage("gpt-luna", 1, "high").outputTokens;
		expect(medium).toBeGreaterThan(low ?? 0);
		expect(high).toBeGreaterThanOrEqual(medium ?? 0);
	});

	it("Claude経路も effort で出力見積が増える", () => {
		const low = estimateLabelReserveUsage(
			"web-research",
			1,
			"low",
		).outputTokens;
		const high = estimateLabelReserveUsage(
			"web-research",
			1,
			"high",
		).outputTokens;
		expect(high).toBeGreaterThan(low ?? 0);
	});

	it("一括抽出も effort で出力見積が増える", () => {
		for (const route of WINE_LIST_ROUTE_KEYS) {
			const low = estimateWineListReserveUsage(route, 1, "low").outputTokens;
			const high = estimateWineListReserveUsage(route, 1, "high").outputTokens;
			expect(high).toBeGreaterThan(low ?? 0);
		}
	});

	it("標準(standard)経路も effort で出力見積が増える", () => {
		// 標準経路は Luna の単発抽出で reasoning を使うため、深く考えさせるほど
		// 出力の中心値が上がる(旧 Workers AI 経路は reasoning を使わなかった)。
		const outputs = (["low", "medium", "high"] as ReasoningEffortKey[]).map(
			(e) => estimateLabelReserveUsage("standard", 1, e).outputTokens,
		);
		expect(outputs[1]).toBeGreaterThan(outputs[0] ?? 0);
		expect(outputs[2]).toBeGreaterThan(outputs[1] ?? 0);
	});

	it("effort 省略時は low と同じ(既存呼び出しの互換性)", () => {
		expect(estimateLabelReserveUsage("gpt-luna", 1)).toEqual(
			estimateLabelReserveUsage("gpt-luna", 1, "low"),
		);
		expect(estimateWineListReserveUsage("gpt-luna", 2)).toEqual(
			estimateWineListReserveUsage("gpt-luna", 2, "low"),
		);
	});
});
// 選択されたエンジンと実際に走る経路の対応づけ。#602 で接続先を OpenRouter に
// 集約したため、キーがあるかないかの二択になった。キー未設定時は null を返し、
// 別モデルへの自動フォールバックはしない。表示と予約が食い違わないよう、ここが SSOT。
describe("resolveLabelRoute", () => {
	const available = { openrouter: true };
	const unavailable = { openrouter: false };

	it("接続があれば選択どおりの経路になる", () => {
		expect(resolveLabelRoute("gpt-luna", available)).toBe("gpt-luna");
		expect(resolveLabelRoute("web-research", available)).toBe("web-research");
		expect(resolveLabelRoute("standard", available)).toBe("standard");
	});

	it("接続が無ければ null(利用不可)を返す", () => {
		expect(resolveLabelRoute("gpt-luna", unavailable)).toBeNull();
		expect(resolveLabelRoute("web-research", unavailable)).toBeNull();
		expect(resolveLabelRoute("standard", unavailable)).toBeNull();
	});

	it("既定エンジンは接続時に必ず解決先を持つ", () => {
		expect(LABEL_ENGINE_KEYS).toContain(
			resolveLabelRoute(DEFAULT_LABEL_ENGINE, available),
		);
	});
});

describe("resolveWineListRoute", () => {
	it("接続があれば選択どおりの経路になる(standard は gpt-luna へ載る)", () => {
		const available = { openrouter: true };
		expect(resolveWineListRoute("gpt-luna", available)).toBe("gpt-luna");
		expect(resolveWineListRoute("web-research", available)).toBe(
			"web-research",
		);
		expect(resolveWineListRoute("standard", available)).toBe("gpt-luna");
	});

	it("接続が無ければ null(利用不可)を返す", () => {
		const unavailable = { openrouter: false };
		expect(resolveWineListRoute("gpt-luna", unavailable)).toBeNull();
		expect(resolveWineListRoute("web-research", unavailable)).toBeNull();
	});
});

// 旧エンジン値の読み替え(#602 の移行対応表)。D1 に残る旧値は用途別の対応先へ
// 解決し、対応先が無い旧値は既定へ倒す(呼び出し側の ?? DEFAULT)。
describe("toLabelEngineKeyWithCompat", () => {
	it("旧 workers-ai は standard へ読み替える", () => {
		expect(toLabelEngineKeyWithCompat("workers-ai")).toBe("standard");
	});

	it("現行キーはそのまま通る", () => {
		for (const key of LABEL_ENGINE_KEYS) {
			expect(toLabelEngineKeyWithCompat(key)).toBe(key);
		}
	});

	it("対応先が無い旧値・不正値は null", () => {
		expect(toLabelEngineKeyWithCompat("web-research-legacy")).toBeNull();
		expect(toLabelEngineKeyWithCompat("")).toBeNull();
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
		expect(microUsd("standard", 1)).toBeLessThan(microUsd("gpt-luna", 1));
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
			estimateLabelReserveUsage("standard", 1).webSearches,
		).toBeUndefined();
	});

	it("標準経路は無料会員の月次付与で複数回使える", () => {
		// 「高精度が高くて使えない」ときの逃げ道なので、ここが付与額に近づくと
		// 無料会員は自動入力を実質使えなくなる。
		expect(costToCredits(microUsd("standard", 1)) * 10).toBeLessThanOrEqual(
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
