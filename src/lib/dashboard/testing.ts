import type { RegionId } from "#/lib/wine/types";
import type { RegionStat } from "./recommend";

// ダッシュボード系の単体テストで共用する RegionStat スタブ。
// recommend.test.ts と learning-path.test.ts で同じファクトリを使い、
// テストヘルパーの複製を作らない(#207)。

export function stubRegionStat(
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
