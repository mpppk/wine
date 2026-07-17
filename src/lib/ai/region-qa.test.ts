import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import { AI_MAX_HISTORY_MESSAGES, AI_MAX_OUTPUT_TOKENS } from "./config";
import {
	buildRegionChatMessages,
	buildRegionContext,
	type ChatMessage,
	clampHistory,
	estimateReserveTokens,
	type RegionContextInput,
	stripReasoning,
} from "./region-qa";

const baseContext: RegionContextInput = {
	regionNameJa: "ブルゴーニュ",
	regionNameLocal: "Bourgogne",
	countryJa: "フランス",
	regionDescription: "フランス東部の銘醸地。",
	subregionNames: ["コート・ド・ニュイ", "コート・ド・ボーヌ"],
	aopNames: ["ジュヴレ・シャンベルタン", "ヴォーヌ・ロマネ"],
	aop: {
		nameJa: "ジュヴレ・シャンベルタン",
		shortName: "Gevrey-Chambertin",
		kind: "village",
		soil: "石灰質",
		description: "力強い赤で知られる村。",
		grapeLabels: ["ピノ・ノワール"],
		producerNames: ["Armand Rousseau"],
	},
};

describe("buildRegionContext", () => {
	it("地域・AOPのグラウンディングを含む", () => {
		const ctx = buildRegionContext(baseContext);
		expect(ctx).toContain("ブルゴーニュ");
		expect(ctx).toContain("フランス東部の銘醸地。");
		expect(ctx).toContain("ジュヴレ・シャンベルタン");
		expect(ctx).toContain("石灰質");
		expect(ctx).toContain("ピノ・ノワール");
	});

	it("約1KB以内に収まる", () => {
		const huge: RegionContextInput = {
			...baseContext,
			aopNames: Array.from({ length: 500 }, (_, i) => `AOP-${i}`),
		};
		expect(buildRegionContext(huge).length).toBeLessThanOrEqual(1300);
	});
});

describe("clampHistory", () => {
	it("上限以内はそのまま", () => {
		const h: ChatMessage[] = [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		];
		expect(clampHistory(h)).toEqual(h);
	});

	it("上限を超えたら直近だけ残す(古い順に落とす)", () => {
		const h: ChatMessage[] = Array.from(
			{ length: AI_MAX_HISTORY_MESSAGES + 4 },
			(_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `m${i}`,
			}),
		);
		const clamped = clampHistory(h);
		expect(clamped).toHaveLength(AI_MAX_HISTORY_MESSAGES);
		expect(clamped[clamped.length - 1]).toEqual(h[h.length - 1]);
	});
});

describe("buildRegionChatMessages", () => {
	it("system 先頭 + 履歴 + 新規質問(末尾)", () => {
		const history: ChatMessage[] = [
			{ role: "user", content: "赤ですか?" },
			{ role: "assistant", content: "はい" },
		];
		const messages = buildRegionChatMessages({
			context: baseContext,
			history,
			question: "土壌は?",
		});
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content).toContain("地域情報");
		expect(messages[messages.length - 1]).toEqual({
			role: "user",
			content: "土壌は?",
		});
		expect(messages).toHaveLength(1 + history.length + 1);
	});
});

describe("stripReasoning", () => {
	it("閉じタグ有りの think ブロックを除去", () => {
		expect(stripReasoning("<think>考え中...</think>ピノ・ノワールです。")).toBe(
			"ピノ・ノワールです。",
		);
	});

	it("閉じタグ無し(途中切れ)は think 以降を落とす", () => {
		expect(stripReasoning("答え。<think>まだ考えている")).toBe("答え。");
	});

	it("think が無ければそのまま", () => {
		expect(stripReasoning("シャルドネです。")).toBe("シャルドネです。");
	});

	it("全部が思考なら元テキストを返す(無回答を避ける)", () => {
		expect(stripReasoning("<think>ぐるぐる</think>")).toBe(
			"<think>ぐるぐる</think>",
		);
	});
});

describe("estimateReserveTokens", () => {
	it("プロンプト推定 + 出力上限。上限を超えたらクランプ", () => {
		const small = estimateReserveTokens([{ role: "user", content: "短い" }]);
		expect(small).toBeGreaterThanOrEqual(AI_MAX_OUTPUT_TOKENS);
		expect(small).toBeLessThan(AI_MAX_ESTIMATE_TOKENS);

		const huge = estimateReserveTokens([
			{ role: "user", content: "あ".repeat(AI_MAX_ESTIMATE_TOKENS * 4) },
		]);
		expect(huge).toBe(AI_MAX_ESTIMATE_TOKENS);
	});
});
