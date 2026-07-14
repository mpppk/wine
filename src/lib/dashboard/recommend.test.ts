import { describe, expect, it } from "vitest";
import type { RegionId } from "#/lib/wine/types";
import { pickRecommendation, type RegionStat } from "./recommend";

// 実在する RegionId を使う(型が enum で固定のため)
const A: RegionId = "bourgogne";
const B: RegionId = "beaujolais";

function stat(
	partial: Partial<RegionStat> & { regionId: RegionId },
): RegionStat {
	return {
		candidateCount: 100,
		seenCount: 0,
		weakCount: 0,
		masteredCount: 0,
		...partial,
	};
}

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

	it("苦手が最も多い地域を最優先する", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, weakCount: 2, seenCount: 50 }),
			stat({ regionId: B, weakCount: 5, seenCount: 50 }),
		]);
		expect(rec).toEqual({ regionId: B, reason: "weak", count: 5 });
	});

	it("苦手が無ければ未出題が最も多い地域", () => {
		const rec = pickRecommendation([
			stat({ regionId: A, candidateCount: 100, seenCount: 90 }), // unseen 10
			stat({ regionId: B, candidateCount: 100, seenCount: 30 }), // unseen 70
		]);
		expect(rec).toEqual({ regionId: B, reason: "unseen", count: 70 });
	});

	it("全問出題済みなら習得率が最も低い地域(mastery)", () => {
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
				masteredCount: 40,
			}),
		]);
		expect(rec).toEqual({ regionId: B, reason: "mastery", count: 0 });
	});
});
