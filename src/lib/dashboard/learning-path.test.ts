import { describe, expect, it } from "vitest";
import { REGIONS } from "#/lib/wine/regions";
import { REGION_ID_LIST, type RegionId } from "#/lib/wine/types";
import {
	isPathStepComplete,
	LEARNING_PATH_COMPLETE_RATE,
	LEARNING_PATH_ORDER,
	masteredRate,
	pickLearningPathStep,
	regionPathStatus,
	summarizeRegionProgress,
} from "./learning-path";
import type { RegionStat } from "./recommend";
import { stubRegionStat as stat } from "./testing";

const A: RegionId = "bourgogne";
const B: RegionId = "beaujolais";

describe("LEARNING_PATH_ORDER", () => {
	it("全地域を過不足なく1度ずつ含む", () => {
		expect([...LEARNING_PATH_ORDER].sort()).toEqual([...REGION_ID_LIST].sort());
	});

	it("learningOrder 順に並ぶ(先頭は起点のブルゴーニュ)", () => {
		const byId = new Map(REGIONS.map((r) => [r.id, r]));
		const orders = LEARNING_PATH_ORDER.map((id) => byId.get(id)?.learningOrder);
		expect(orders).toEqual([...(orders as number[])].sort((a, b) => a - b));
		expect(LEARNING_PATH_ORDER[0]).toBe("bourgogne");
	});
});

describe("masteredRate / isPathStepComplete", () => {
	it("習得率を返す(候補数ベースで地域差を吸収する)", () => {
		expect(masteredRate(stat({ regionId: A, candidateCount: 200 }))).toBe(0);
		expect(
			masteredRate(
				stat({ regionId: A, candidateCount: 200, masteredCount: 100 }),
			),
		).toBe(0.5);
	});

	it("出題不能な地域はパスを塞がないよう完了扱い", () => {
		expect(masteredRate(stat({ regionId: A, candidateCount: 0 }))).toBe(1);
		expect(isPathStepComplete(stat({ regionId: A, candidateCount: 0 }))).toBe(
			true,
		);
	});

	it(`完了ラインは習熟率 ${LEARNING_PATH_COMPLETE_RATE}(境界を含む)`, () => {
		expect(LEARNING_PATH_COMPLETE_RATE).toBe(0.5);
		expect(
			isPathStepComplete(
				stat({ regionId: A, candidateCount: 100, masteredCount: 50 }),
			),
		).toBe(true);
		expect(
			isPathStepComplete(
				stat({ regionId: A, candidateCount: 100, masteredCount: 49 }),
			),
		).toBe(false);
	});
});

describe("pickLearningPathStep", () => {
	it("空なら null(パス完了扱い)", () => {
		expect(pickLearningPathStep([])).toBeNull();
	});

	it("未着手なら起点が現在地・2番目が次", () => {
		const step = pickLearningPathStep([
			stat({ regionId: A }),
			stat({ regionId: B }),
		]);
		expect(step).toEqual({
			currentRegionId: A,
			nextRegionId: B,
			completedRegionIds: [],
		});
	});

	it("完了した地域を飛ばして現在地を進める", () => {
		const step = pickLearningPathStep([
			stat({ regionId: A, candidateCount: 100, masteredCount: 80 }),
			stat({ regionId: B }),
		]);
		expect(step?.currentRegionId).toBe(B);
		expect(step?.nextRegionId).toBeNull();
		expect(step?.completedRegionIds).toEqual([A]);
	});

	it("全完了なら null", () => {
		expect(
			pickLearningPathStep([
				stat({ regionId: A, candidateCount: 100, masteredCount: 60 }),
				stat({ regionId: B, candidateCount: 100, masteredCount: 100 }),
			]),
		).toBeNull();
	});

	it("入力順に依存せずパス順で現在地を決める", () => {
		const forward = pickLearningPathStep([
			stat({ regionId: A }),
			stat({ regionId: B }),
		]);
		const reversed = pickLearningPathStep([
			stat({ regionId: B }),
			stat({ regionId: A }),
		]);
		expect(reversed).toEqual(forward);
	});
});

describe("summarizeRegionProgress", () => {
	it("地域×形式を地域単位に畳む", () => {
		const statResult = summarizeRegionProgress({
			regionId: A,
			quizTypes: [
				{
					quizType: "colors",
					candidateCount: 10,
					seenCount: 6,
					answerCount: 8,
					correctCount: 5,
					weakCount: 2,
					masteredCount: 3,
				},
				{
					quizType: "location",
					candidateCount: 5,
					seenCount: 5,
					answerCount: 5,
					correctCount: 5,
					weakCount: 0,
					masteredCount: 4,
				},
			],
		});
		const expected: RegionStat = {
			regionId: A,
			candidateCount: 15,
			seenCount: 11,
			weakCount: 2,
			masteredCount: 7,
		};
		expect(statResult).toEqual(expected);
	});
});

describe("regionPathStatus", () => {
	const step = {
		currentRegionId: A,
		nextRegionId: B,
		completedRegionIds: [] as RegionId[],
	};

	it("現在地・次・完了を返す", () => {
		expect(regionPathStatus(A, step)).toBe("current");
		expect(regionPathStatus(B, step)).toBe("next");
		expect(regionPathStatus("bordeaux", step)).toBeNull();
	});

	it("完了は現在地より優先する", () => {
		expect(regionPathStatus(A, { ...step, completedRegionIds: [A] })).toBe(
			"done",
		);
	});

	it("ステップなし(未ログイン等)は null", () => {
		expect(regionPathStatus(A, null)).toBeNull();
	});
});
