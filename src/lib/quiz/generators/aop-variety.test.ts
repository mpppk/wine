import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { parseKey } from "../keys";
import { principalComboId } from "../labels";
import { mulberry32 } from "../rng";
import {
	enumerateAopVarietyKeys,
	materializeAopVarietyQuestion,
} from "./aop-variety";

const byId = new Map(AOPS.map((a) => [a.id, a]));

describe("主要品種クイズ", () => {
	it("主要品種を持つ全AOP分のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateAopVarietyKeys(r));
		const withPrincipal = AOPS.filter((a) =>
			a.grapes.some((g) => g.role === "principal"),
		);
		expect(total.length).toBe(withPrincipal.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("全キーの全数スイープ: 4択・重複なし・正解が実データの主要品種コンボと一致", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateAopVarietyKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "aop-variety") throw new Error(key);
				const q = materializeAopVarietyQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				expect(q.options.some((o) => o.id === q.correctOptionId)).toBe(true);
				const aop = byId.get(q.subjectAopId);
				expect(q.correctOptionId).toBe(principalComboId(aop ?? ({} as never)));
				// 誤答コンボはすべて対象AOPの主要品種コンボと不一致
				for (const option of q.options) {
					if (option.id === q.correctOptionId) continue;
					expect(option.id, key).not.toBe(q.correctOptionId);
				}
			}
		}
	});

	it("固定RNGで決定的", () => {
		const parsed = { quizType: "aop-variety", aopId: "chablis" } as const;
		const q1 = materializeAopVarietyQuestion(parsed, mulberry32(7));
		const q2 = materializeAopVarietyQuestion(parsed, mulberry32(7));
		expect(q1).toEqual(q2);
	});

	it("存在しないAOPは null", () => {
		expect(
			materializeAopVarietyQuestion(
				{ quizType: "aop-variety", aopId: "no-such-aop" },
				mulberry32(1),
			),
		).toBeNull();
	});
});
