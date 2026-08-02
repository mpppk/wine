import { describe, expect, it } from "vitest";
import {
	AI_LABEL_ROUTE_MODELS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_MODEL,
} from "#/lib/ai/config";
import {
	AI_MAX_ESTIMATE_MICRO_USD,
	AI_MODEL_PRICING,
	addUsage,
	clampEstimateMicroUsd,
	getModelPricing,
	MICRO_USD_PER_CREDIT,
	totalTokens,
	usageToMicroUsd,
	WEB_SEARCH_MICRO_USD_PER_CALL,
} from "./ai-pricing";

describe("AI_MODEL_PRICING", () => {
	// これが本命の回帰テスト。単価表に載せ忘れたモデルはフォールバック単価(最高単価)で
	// 課金され、原価に対して静かに過大請求になる。モデルを足す変更で必ず落ちるようにする
	// (AiModels 型への未登録で繰り返しハマった #100〜#110 と同じ形の防御)。
	it("実際に呼ぶモデルIDがすべて単価表に載っている", () => {
		const called = [
			...Object.values(AI_LABEL_ROUTE_MODELS),
			...Object.values(AI_REGION_QA_MODELS).map((m) => m.id),
			AI_WINE_LIST_MODEL,
		];
		for (const model of called) {
			expect(getModelPricing(model), `単価未登録: ${model}`).not.toBeNull();
		}
	});

	it("出力単価は入力単価以上(単価の取り違えを検出する)", () => {
		for (const [model, p] of Object.entries(AI_MODEL_PRICING)) {
			expect(p.outputUsdPerMTok, model).toBeGreaterThanOrEqual(
				p.inputUsdPerMTok,
			);
		}
	});

	it("キャッシュ読み出しは入力より安く、書き込みは入力以上", () => {
		for (const [model, p] of Object.entries(AI_MODEL_PRICING)) {
			if (p.cacheReadUsdPerMTok !== undefined) {
				expect(p.cacheReadUsdPerMTok, model).toBeLessThan(p.inputUsdPerMTok);
			}
			if (p.cacheWriteUsdPerMTok !== undefined) {
				expect(p.cacheWriteUsdPerMTok, model).toBeGreaterThanOrEqual(
					p.inputUsdPerMTok,
				);
			}
		}
	});
});

describe("usageToMicroUsd", () => {
	it("µUSD = トークン数 × (USD per MTok) の恒等式が成り立つ", () => {
		// claude-opus-5 は $5/MTok 入力・$25/MTok 出力。
		expect(usageToMicroUsd("claude-opus-5", { inputTokens: 30_000 })).toBe(
			150_000,
		);
		expect(usageToMicroUsd("claude-opus-5", { outputTokens: 2_000 })).toBe(
			50_000,
		);
	});

	it("キャッシュ読み書きをそれぞれの単価で換算する", () => {
		// opus: 書き込み $6.25/MTok・読み出し $0.50/MTok
		expect(
			usageToMicroUsd("claude-opus-5", {
				cacheWriteTokens: 1_000,
				cacheReadTokens: 10_000,
			}),
		).toBe(6_250 + 5_000);
	});

	it("キャッシュ単価が未定義のモデルは入力単価で換算する(割引を勝手に仮定しない)", () => {
		// Workers AI はキャッシュ単価を持たない。
		expect(
			usageToMicroUsd("@cf/google/gemma-4-26b-a4b-it", {
				cacheReadTokens: 10_000,
			}),
		).toBe(
			usageToMicroUsd("@cf/google/gemma-4-26b-a4b-it", {
				inputTokens: 10_000,
			}),
		);
	});

	it("web検索を回数課金として加算する(トークンでは表現できない項目)", () => {
		expect(usageToMicroUsd("gpt-5.6-luna", { webSearches: 3 })).toBe(
			3 * WEB_SEARCH_MICRO_USD_PER_CALL,
		);
	});

	it("経路ごとの実費差が単価に反映される", () => {
		const usage = { inputTokens: 30_000, outputTokens: 2_000 };
		const opus = usageToMicroUsd("claude-opus-5", usage);
		const luna = usageToMicroUsd("gpt-5.6-luna", usage);
		const workersAi = usageToMicroUsd(
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			usage,
		);
		// 同じトークン数でも opus は Luna の20倍以上、Workers AI の10倍以上かかる。
		// この差を潰さないことが #355 の目的そのもの。
		expect(opus).toBeGreaterThan(luna * 20);
		expect(opus).toBeGreaterThan(workersAi * 10);
	});

	it("端数は切り上げる(過小請求を避ける)", () => {
		// gemma4 入力 $0.10/MTok → 1トークン = 0.1µUSD
		expect(
			usageToMicroUsd("@cf/google/gemma-4-26b-a4b-it", {
				inputTokens: 1,
			}),
		).toBe(1);
	});

	it("未登録モデルは throw せず最高単価で換算する", () => {
		// settle は推論成功の後に走る。ここで throw すると成功した推論が失敗扱いで
		// 全額返却され、原価だけ出てクレジットを取り損ねる。
		const unknown = usageToMicroUsd("no-such-model-9999", {
			inputTokens: 1_000,
			outputTokens: 1_000,
		});
		const highest = Math.max(
			...Object.keys(AI_MODEL_PRICING).map((m) =>
				usageToMicroUsd(m, { inputTokens: 1_000, outputTokens: 1_000 }),
			),
		);
		expect(unknown).toBe(highest);
	});

	it("空の usage は0", () => {
		expect(usageToMicroUsd("claude-opus-5", {})).toBe(0);
	});
});

describe("addUsage / totalTokens", () => {
	it("フィールドごとに加算する(pause_turn の継続ループ用)", () => {
		const sum = addUsage(
			{ inputTokens: 10, outputTokens: 2, webSearches: 1 },
			{ inputTokens: 5, cacheReadTokens: 7, webSearches: 2 },
		);
		expect(sum).toEqual({
			inputTokens: 15,
			outputTokens: 2,
			cacheWriteTokens: 0,
			cacheReadTokens: 7,
			webSearches: 3,
		});
	});

	it("総トークンにweb検索回数は混ざらない(単位が違う)", () => {
		expect(
			totalTokens({ inputTokens: 10, outputTokens: 2, webSearches: 99 }),
		).toBe(12);
	});
});

describe("clampEstimateMicroUsd", () => {
	it("上限を超える見積はクランプする(暴走・過大請求のガード)", () => {
		expect(clampEstimateMicroUsd(AI_MAX_ESTIMATE_MICRO_USD * 10)).toBe(
			AI_MAX_ESTIMATE_MICRO_USD,
		);
	});

	it("上限以下はそのまま", () => {
		expect(clampEstimateMicroUsd(1_234)).toBe(1_234);
	});

	it("1回の予約上限はプレミアムの月次付与を超えない", () => {
		// 超えると、その経路は誰にも一度も使えない(予約が必ず残高不足で弾かれる)。
		expect(AI_MAX_ESTIMATE_MICRO_USD).toBeLessThan(1500 * MICRO_USD_PER_CREDIT);
	});
});
