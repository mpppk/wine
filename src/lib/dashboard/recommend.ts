import type { RegionId } from "#/lib/wine/types";

// 「今日はどこから学べばよいか」を1件選ぶ純関数。DBアクセスはサービス層が担う。

/** recommend が必要とする地域単位の集計(RegionProgress から算出して渡す) */
export interface RegionStat {
	regionId: RegionId;
	/** 生成可能な問題総数 */
	candidateCount: number;
	/** 一度でも解いた問題数 */
	seenCount: number;
	/** 苦手(直近不正解)の問題数 */
	weakCount: number;
	/** 習得済み(2連続以上正解)の問題数 */
	masteredCount: number;
}

/** おすすめの理由。UIの見出し・説明の出し分けに使う */
export type RecommendationReason = "weak" | "unseen" | "mastery" | "empty";

export interface Recommendation {
	regionId: RegionId | null;
	reason: RecommendationReason;
	/** 理由に応じた対象問題数(苦手数 / 未出題数)。mastery/empty では 0 */
	count: number;
}

/**
 * 優先度「苦手が最も多い地域 → 未出題が最も多い地域 → 習熟度が最も低い地域」で
 * 1地域を選ぶ。候補問題を持つ地域が無ければ reason: "empty"。
 */
export function pickRecommendation(
	regions: readonly RegionStat[],
): Recommendation {
	const playable = regions.filter((r) => r.candidateCount > 0);
	if (playable.length === 0) {
		return { regionId: null, reason: "empty", count: 0 };
	}

	// playable は上の早期returnで非空が保証されるため、各ソート結果の先頭は必ず存在する。
	// noUncheckedIndexedAccess 下では型がそれを追えないので先頭要素をローカルに束縛して扱う。

	// 1) 苦手が最も多い地域(苦手があれば最優先で復習に誘導)
	const byWeak = [...playable].sort((a, b) => b.weakCount - a.weakCount);
	const topWeak = byWeak[0];
	if (topWeak && topWeak.weakCount > 0) {
		return {
			regionId: topWeak.regionId,
			reason: "weak",
			count: topWeak.weakCount,
		};
	}

	// 2) 未出題が最も多い地域(新規学習を促す)
	const unseen = (r: RegionStat) => r.candidateCount - r.seenCount;
	const byUnseen = [...playable].sort((a, b) => unseen(b) - unseen(a));
	const topUnseen = byUnseen[0];
	if (topUnseen && unseen(topUnseen) > 0) {
		return {
			regionId: topUnseen.regionId,
			reason: "unseen",
			count: unseen(topUnseen),
		};
	}

	// 3) 全問出題済み: 習熟度(習得率)が最も低い地域を復習対象にする
	const mastery = (r: RegionStat) => r.masteredCount / r.candidateCount;
	const byMastery = [...playable].sort((a, b) => mastery(a) - mastery(b));
	const topMastery = byMastery[0];
	if (!topMastery) return { regionId: null, reason: "empty", count: 0 };
	return { regionId: topMastery.regionId, reason: "mastery", count: 0 };
}
