import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { duplicatesUmbrellaFact, isOpenEndedAppellation } from "../aop-pool";
import { colorComboId } from "../labels";
import { mulberry32 } from "../rng";
import { enumerateColorsKeys, materializeColorsQuestion } from "./colors";

describe("生産可能色クイズ", () => {
	// IGT(開かれた広域呼称)は colors が網羅でないため対象外(#212)。
	// 色コンボが上位AOP(傘AOC/村)と同じ畑は上位側の1問に集約するため対象外
	// (aop-pool.ts 参照)。それ以外のAOPは全件出題されることを固定する。
	it("IGTと上位AOPに集約される畑を除く全AOP分のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateColorsKeys(r));
		const eligible = AOPS.filter(
			(a) =>
				!isOpenEndedAppellation(a) &&
				!duplicatesUmbrellaFact(a, (x) =>
					isOpenEndedAppellation(x) ? undefined : colorComboId(x.colors),
				),
		);
		expect(eligible.length).toBeLessThan(AOPS.length);
		expect(total.length).toBe(eligible.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("色が上位AOPと同じ畑は出題されず、異なる畑は残る", () => {
		const bourgogne = enumerateColorsKeys("bourgogne");
		// シャブリ・グラン・クリュの7クリマは全て親と同じ「白のみ」→ 集約先はシャブリ
		// (傘AOC自身もシャブリと同一内容なのでさらに集約される)
		expect(bourgogne).toContain("colors:chablis");
		expect(bourgogne).not.toContain("colors:chablis-grand-cru");
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
		// #436: 独立AOCのグラン・クリュも村と同じ色なら村側の1問に集約する
		expect(bourgogne).toContain("colors:gevrey-chambertin");
		expect(bourgogne).not.toContain("colors:chambertin");
		expect(bourgogne).not.toContain("colors:romanee-conti");
		// 村(赤のみ)と色が異なるミュジニー(赤・白)は残る
		expect(bourgogne).toContain("colors:musigny");
		// 複数村のうちモレ・サン・ドニ(赤・白)と異なるボンヌ・マール(赤のみ)も残る
		expect(bourgogne).toContain("colors:bonnes-mares");
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
