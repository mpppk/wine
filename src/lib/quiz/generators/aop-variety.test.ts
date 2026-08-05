import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { duplicatesUmbrellaFact, isOpenEndedAppellation } from "../aop-pool";
import { parseKey } from "../keys";
import { principalComboId } from "../labels";
import { mulberry32 } from "../rng";
import {
	enumerateAopVarietyKeys,
	materializeAopVarietyQuestion,
} from "./aop-variety";

const byId = new Map(AOPS.map((a) => [a.id, a]));

describe("主要品種クイズ", () => {
	// IGT(開かれた広域呼称)は「主要品種」が定まらないため対象外(#212)。
	// 主要品種コンボが上位AOP(傘AOC/村)と同じ畑は上位側の1問に集約するため対象外
	// (aop-pool.ts 参照)。
	it("主要品種を持つ全AOP分(IGTと上位AOPに集約される畑を除く)のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateAopVarietyKeys(r));
		const withPrincipal = AOPS.filter(
			(a) =>
				a.grapes.some((g) => g.role === "principal") &&
				!isOpenEndedAppellation(a) &&
				!duplicatesUmbrellaFact(a, (x) =>
					isOpenEndedAppellation(x) ? undefined : principalComboId(x),
				),
		);
		expect(total.length).toBe(withPrincipal.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("主要品種が上位AOPと同じ畑は出題されず、異なる畑は残る", () => {
		const bourgogne = enumerateAopVarietyKeys("bourgogne");
		// シャブリ・グラン・クリュの7クリマは全て親と同じシャルドネ → 集約先はシャブリ
		expect(bourgogne).toContain("aop-variety:chablis");
		expect(bourgogne).not.toContain("aop-variety:chablis-grand-cru");
		expect(bourgogne.some((k) => k.startsWith("aop-variety:chablis-gc-"))).toBe(
			false,
		);
		expect(
			bourgogne.some((k) => k.startsWith("aop-variety:chablis-1er-")),
		).toBe(false);
		// コルトンのクリマは主要品種が親(ピノ・ノワール+シャルドネ)と異なるため残る
		expect(bourgogne).toContain("aop-variety:corton-les-bressandes");
		// #436: 独立AOCのグラン・クリュも村と同じ主要品種なら村側の1問に集約する
		expect(bourgogne).toContain("aop-variety:gevrey-chambertin");
		expect(bourgogne).not.toContain("aop-variety:chambertin");
		expect(bourgogne).not.toContain("aop-variety:romanee-conti");
	});

	it("親畑と主要品種が同じクリマのキーは具現化されない(失効キー扱い)", () => {
		expect(
			materializeAopVarietyQuestion(
				{ quizType: "aop-variety", aopId: "chablis-gc-les-clos" },
				mulberry32(1),
			),
		).toBeNull();
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
