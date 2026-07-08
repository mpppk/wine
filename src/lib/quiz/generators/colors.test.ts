import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { colorComboId } from "../labels";
import { mulberry32 } from "../rng";
import { enumerateColorsKeys, materializeColorsQuestion } from "./colors";

describe("生産可能色クイズ", () => {
	it("全AOP分のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateColorsKeys(r));
		expect(total.length).toBe(AOPS.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("全キーの全数スイープ: 4択・重複なし・正解が実データと一致", () => {
		const rng = mulberry32(42);
		const byId = new Map(AOPS.map((a) => [a.id, a]));
		for (const regionId of REGION_IDS) {
			for (const key of enumerateColorsKeys(regionId)) {
				const q = materializeColorsQuestion(
					{ quizType: "colors", aopId: key.split(":")[1] },
					rng,
				);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				expect(q.options.some((o) => o.id === q.correctOptionId)).toBe(true);
				const aop = byId.get(q.subjectAopId);
				expect(q.correctOptionId).toBe(colorComboId(aop?.colors ?? []));
				// 誤答コンボはすべて実データの colors と不一致
				for (const option of q.options) {
					if (option.id === q.correctOptionId) continue;
					expect(option.id, key).not.toBe(colorComboId(aop?.colors ?? []));
				}
			}
		}
	});

	it("固定RNGで決定的", () => {
		const parsed = { quizType: "colors", aopId: "gevrey-chambertin" } as const;
		const q1 = materializeColorsQuestion(parsed, mulberry32(7));
		const q2 = materializeColorsQuestion(parsed, mulberry32(7));
		expect(q1).toEqual(q2);
	});

	it("存在しないAOPは null", () => {
		expect(
			materializeColorsQuestion(
				{ quizType: "colors", aopId: "no-such-aop" },
				mulberry32(1),
			),
		).toBeNull();
	});
});
