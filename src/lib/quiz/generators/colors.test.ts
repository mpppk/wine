import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { duplicatesParentFact, isOpenEndedAppellation } from "../aop-pool";
import { colorComboId } from "../labels";
import { mulberry32 } from "../rng";
import { enumerateColorsKeys, materializeColorsQuestion } from "./colors";

describe("生産可能色クイズ", () => {
	// IGT(開かれた広域呼称)は colors が網羅でないため対象外(#212)。
	// 色コンボが親畑と同じクリマは親側の1問に集約するため対象外(aop-pool.ts 参照)。
	// それ以外のAOPは全件出題されることを固定する。
	it("IGTと親畑に集約されるクリマを除く全AOP分のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateColorsKeys(r));
		const eligible = AOPS.filter(
			(a) =>
				!isOpenEndedAppellation(a) &&
				!duplicatesParentFact(a, (x) => colorComboId(x.colors)),
		);
		expect(eligible.length).toBeLessThan(AOPS.length);
		expect(total.length).toBe(eligible.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("色が親畑と同じクリマは出題されず、異なるクリマは残る", () => {
		const bourgogne = enumerateColorsKeys("bourgogne");
		// シャブリ・グラン・クリュの7クリマは全て親と同じ「白のみ」→ 親の1問に集約
		expect(bourgogne).toContain("colors:chablis-grand-cru");
		expect(bourgogne).not.toContain("colors:chablis-gc-les-clos");
		expect(bourgogne.some((k) => k.startsWith("colors:chablis-gc-"))).toBe(
			false,
		);
		expect(bourgogne.some((k) => k.startsWith("colors:chablis-1er-"))).toBe(
			false,
		);
		// コルトンのクリマは親(赤白)と色が異なるものだけ残る
		expect(bourgogne).toContain("colors:corton-les-bressandes"); // 赤のみ
		expect(bourgogne).not.toContain("colors:corton-le-corton"); // 親と同じ赤白
	});

	it("親畑と同じ色のクリマのキーは具現化されない(失効キー扱い)", () => {
		expect(
			materializeColorsQuestion(
				{ quizType: "colors", aopId: "chablis-gc-les-clos" },
				mulberry32(1),
			),
		).toBeNull();
	});

	it("全キーの全数スイープ: 4択・重複なし・正解が実データと一致", () => {
		const rng = mulberry32(42);
		const byId = new Map(AOPS.map((a) => [a.id, a]));
		for (const regionId of REGION_IDS) {
			for (const key of enumerateColorsKeys(regionId)) {
				const q = materializeColorsQuestion(
					{ quizType: "colors", aopId: key.split(":")[1] ?? "" },
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
