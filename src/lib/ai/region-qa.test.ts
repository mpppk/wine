import { describe, expect, it } from "vitest";
import { AI_MAX_HISTORY_MESSAGES } from "./config";
import {
	buildRegionChatMessages,
	buildRegionContext,
	type ChatMessage,
	clampHistory,
	estimateInputTokens,
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
			system: `ガードレール\n# 地域情報\n${buildRegionContext(baseContext)}`,
			history,
			question: "土壌は?",
		});
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content).toContain("地域情報");
		expect(messages[0]?.content).toContain("ブルゴーニュ");
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

describe("estimateInputTokens", () => {
	it("全メッセージの推定入力トークンを合算する", () => {
		const one = estimateInputTokens([
			{ role: "user", content: "あ".repeat(100) },
		]);
		expect(one).toBe(50); // CHARS_PER_TOKEN_ESTIMATE = 2

		const two = estimateInputTokens([
			{ role: "user", content: "あ".repeat(100) },
			{ role: "assistant", content: "あ".repeat(100) },
		]);
		expect(two).toBe(one * 2);
	});

	it("出力ぶんは含めない(出力単価で別に換算するため)", () => {
		// 空の入力なら 0。ここに出力上限が混ざると、入力単価で出力を課金することになる。
		expect(estimateInputTokens([])).toBe(0);
	});
});
