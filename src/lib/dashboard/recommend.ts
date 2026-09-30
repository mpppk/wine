import type { RegionId } from "#/lib/wine/types";
import { pickLearningPathStep } from "./learning-path";

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
type RecommendationReason = "starter" | "weak" | "unseen" | "mastery" | "empty";

/**
 * まだ何も解いていないユーザに最初に薦める地域。収録数の多寡で決まる "unseen" に
 * 任せると入口が偶然で決まってしまうため、意図して起点を固定する。
 * ブルゴーニュは畑(クリマ)単位の違いがそのまま味の違いになる地域で、
 * 「地図で区画を覚える」というこのアプリの学び方を最も体感しやすい。
 */
export const STARTER_REGION_ID: RegionId = "bourgogne";

export interface Recommendation {
	regionId: RegionId | null;
	reason: RecommendationReason;
	/** 理由に応じた対象問題数(苦手数 / 未出題数)。mastery/empty では 0 */
	count: number;
}

/**
 * 優先度は次の通り。新規学習の向き先は学習パス(#207)に寄せ、苦手の復習は
 * 割り込み(escape hatch)として最優先に残す:
 *   0) starter: まだ1問も解いていない(起点を固定)
 *   1) weak: 苦手が最も多い地域(直近の間違いの復習を最優先)
 *   2) unseen: パス上の現在地に未出題があればそこへ(積み上げを優先)
 *   3) mastery: 現在地は出題済みだが習熟が足りない場合は現在地の復習へ。
 *      パス完了時は全体で習熟度最低の地域へフォールバックする
 * 候補問題を持つ地域が無ければ reason: "empty"。
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

	// 0) まだ1問も解いていない: 起点を固定して「どこから始めるか」を迷わせない。
	//    起点の地域が出題不能(candidateCount 0)なら通常の優先度に委ねる。
	const starter = playable.find((r) => r.regionId === STARTER_REGION_ID);
	if (starter && playable.every((r) => r.seenCount === 0)) {
		return {
			regionId: starter.regionId,
			reason: "starter",
			count: starter.candidateCount,
		};
	}

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

	// 2) 未出題はパス上の現在地を優先する(「今の地域を固めてから次へ」)。
	//    現在地に出題できる問題が無い(見たが習得が足りない)場合は 3) へ進む。
	const unseen = (r: RegionStat) => r.candidateCount - r.seenCount;
	const step = pickLearningPathStep(playable);
	const current = step
		? playable.find((r) => r.regionId === step.currentRegionId)
		: undefined;
	if (current && unseen(current) > 0) {
		return {
			regionId: current.regionId,
			reason: "unseen",
			count: unseen(current),
		};
	}

	// 3) 現在地が出題済みなら現在地の復習。パス完了時(step なし)は全体で
	//    習熟度(習得率)が最も低い地域を復習対象にする。
	if (current) {
		return { regionId: current.regionId, reason: "mastery", count: 0 };
	}
	const mastery = (r: RegionStat) => r.masteredCount / r.candidateCount;
	const byMastery = [...playable].sort((a, b) => mastery(a) - mastery(b));
	const topMastery = byMastery[0];
	if (!topMastery) return { regionId: null, reason: "empty", count: 0 };
	return { regionId: topMastery.regionId, reason: "mastery", count: 0 };
}
