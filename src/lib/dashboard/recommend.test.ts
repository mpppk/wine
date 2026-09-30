import { describe, expect, it } from "vitest";
import type { RegionId } from "#/lib/wine/types";
import { pickRecommendation, STARTER_REGION_ID } from "./recommend";
import { stubRegionStat as stat } from "./testing";

// 実在する RegionId を使う(型が enum で固定のため)
// パス順: A(ブルゴーニュ, 1) → B(ボジョレー, 2)
const A: RegionId = "bourgogne";
const B: RegionId = "beaujolais";

describe("pickRecommendation", () => {
	it("候補が無ければempty", () => {
		expect(pickRecommendation([])).toEqual({
			regionId: null,
			reason: "empty",
			count: 0,
		});
		expect(
			pickRecommendation([stat({ regionId: A, candidateCount: 0 })]),
		).toEqual({ regionId: null, reason: "empty", count: 0 });
	});

	it("まだ1問も解いていなければ収録数によらず起点の地域(ブルゴーニュ)を返す", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, candidateCount: 100 }),
			// 未出題数だけで選ぶと収録数の多いこちらが選ばれてしまう
			stat({ regionId: B, candidateCount: 300 }),
		]);
		expect(rec).toEqual({
			regionId: STARTER_REGION_ID,
			reason: "starter",
			count: 100,
		});
	});

	it("起点の地域が出題不能なら通常の優先度に委ねる", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, candidateCount: 0 }),
			stat({ regionId: B, candidateCount: 300 }),
		]);
		expect(rec).toEqual({ regionId: B, reason: "unseen", count: 300 });
	});

	it("1問でも解いていればstarterにはせずパス上の現在地を返す", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, candidateCount: 100, seenCount: 1 }),
			stat({ regionId: B, candidateCount: 100, seenCount: 0 }),
		]);
		expect(rec).toEqual({ regionId: A, reason: "unseen", count: 99 });
	});

	it("苦手が最も多い地域を最優先する", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, weakCount: 2, seenCount: 50 }),
			stat({ regionId: B, weakCount: 5, seenCount: 50 }),
		]);
		expect(rec).toEqual({ regionId: B, reason: "weak", count: 5 });
	});

	it("苦手があればパス上の現在地より苦手の復習を優先する(escape hatch)", () => {
		const rec = pickRecommendation([
			// A はパス上の現在地だが苦手なし
			stat({ regionId: A, candidateCount: 100, seenCount: 50 }),
			stat({ regionId: B, weakCount: 5, seenCount: 50 }),
		]);
		expect(rec).toEqual({ regionId: B, reason: "weak", count: 5 });
	});

	it("未出題は未出題数ではなくパス上の現在地を優先する", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, candidateCount: 100, seenCount: 90 }), // unseen 10
			stat({ regionId: B, candidateCount: 100, seenCount: 30 }), // unseen 70
		]);
		expect(rec).toEqual({ regionId: A, reason: "unseen", count: 10 });
	});

	it("現在地が出題済みなら未出題の他地域より現在地の復習を優先する", () => {
		const rec = pickRecommendation([
			stat({
				regionId: A,
				candidateCount: 100,
				seenCount: 100,
				masteredCount: 40,
			}),
			stat({ regionId: B, candidateCount: 100, seenCount: 0 }),
		]);
		expect(rec).toEqual({ regionId: A, reason: "mastery", count: 0 });
	});

	it("パス完了時は全体で習熟度が最も低い地域(mastery)へフォールバックする", () => {
		const rec = pickRecommendation([
			stat({
				regionId: A,
				candidateCount: 100,
				seenCount: 100,
				masteredCount: 80,
			}),
			stat({
				regionId: B,
				candidateCount: 100,
				seenCount: 100,
				masteredCount: 60,
			}),
		]);
		expect(rec).toEqual({ regionId: B, reason: "mastery", count: 0 });
	});
});
