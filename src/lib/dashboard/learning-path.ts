import type { RegionProgress } from "#/lib/services/quiz-service";
import { REGIONS } from "#/lib/wine/regions";
import type { RegionId } from "#/lib/wine/types";
import type { RegionStat } from "./recommend";

// 学習パス(地域の推奨学習順)の純ロジック。DBアクセスはサービス層が担い、
// ここは getProgress 由来の集計値だけから「今どこまで進んだか」「次はどこか」を導く。
// 順序のSSOTは regions.ts の learningOrder(根拠は learningNote)。
// 試験の出題頻度は順序の根拠に使わない(#207)。

/**
 * 「その地域を終えた」とみなす習熟率(習得済み/候補問題数)。
 * ブルゴーニュ(候補1,351問)とドイツ(26問)で重さが揃わないため、絶対数ではなく
 * 率で揃える。0.5 は「半分できれば基礎が固まった」と説明できる線で、残り半分は
 * 自由選択・復習で埋める(詰め切りを強制しない)。
 */
export const LEARNING_PATH_COMPLETE_RATE = 0.5;

/** パス順に並べた地域ID。順序のSSOTは各 Region の learningOrder。 */
export const LEARNING_PATH_ORDER: readonly RegionId[] = [...REGIONS]
	.sort((a, b) => a.learningOrder - b.learningOrder)
	.map((r) => r.id);

/** 習熟率(習得済み/候補問題数)。出題不能な地域はパスを塞がないよう完了扱い(1)。 */
export function masteredRate(
	stat: Pick<RegionStat, "candidateCount" | "masteredCount">,
): number {
	if (stat.candidateCount <= 0) return 1;
	return Math.min(1, stat.masteredCount / stat.candidateCount);
}

/** パス上の1ステップが「終えた」か。習熟率ベースで判定する(#207)。 */
export function isPathStepComplete(
	stat: Pick<RegionStat, "candidateCount" | "masteredCount">,
): boolean {
	return masteredRate(stat) >= LEARNING_PATH_COMPLETE_RATE;
}

export interface LearningPathStep {
	/** パス順で最初の未完了地域。今学ぶべき地域 */
	currentRegionId: RegionId;
	/** 現在地の次の未完了地域。無ければ null(現在地が最後の未完了) */
	nextRegionId: RegionId | null;
	/** パス順に並べた完了済み地域ID */
	completedRegionIds: readonly RegionId[];
}

/**
 * パス上の現在地と次を返す。全完了・入力空なら null(パス完了)。
 * 未知の地域IDは無視し、集計の無い地域は未完了として扱う。
 */
export function pickLearningPathStep(
	regions: readonly RegionStat[],
): LearningPathStep | null {
	if (regions.length === 0) return null;
	const byId = new Map(regions.map((r) => [r.regionId, r]));
	const ordered = LEARNING_PATH_ORDER.flatMap((id) => {
		const stat = byId.get(id);
		return stat ? [stat] : [];
	});
	const completedRegionIds = ordered
		.filter(isPathStepComplete)
		.map((r) => r.regionId);
	const incomplete = ordered.filter((r) => !isPathStepComplete(r));
	const [current, next] = incomplete;
	if (!current) return null;
	return {
		currentRegionId: current.regionId,
		nextRegionId: next?.regionId ?? null,
		completedRegionIds,
	};
}

/**
 * RegionProgress(地域×形式)を RegionStat(地域集計)へ畳む。
 * dashboard-service の横断集計と /regions・/quiz のバッジ表示で共用し、
 * 集計ロジックの複製を作らない(#207)。
 */
export function summarizeRegionProgress(progress: RegionProgress): RegionStat {
	const agg = progress.quizTypes.reduce(
		(acc, t) => ({
			candidate: acc.candidate + t.candidateCount,
			seen: acc.seen + t.seenCount,
			mastered: acc.mastered + t.masteredCount,
			weak: acc.weak + t.weakCount,
		}),
		{ candidate: 0, seen: 0, mastered: 0, weak: 0 },
	);
	return {
		regionId: progress.regionId,
		candidateCount: agg.candidate,
		seenCount: agg.seen,
		weakCount: agg.weak,
		masteredCount: agg.mastered,
	};
}

/** バッジ表示用の地域状態。null はパスと無関係(未ログイン時など)。 */
export type RegionPathStatus = "current" | "next" | "done";

/** ステップに対する1地域の表示状態を返す。完了 > 現在地 > 次の優先で1つだけ返す。 */
export function regionPathStatus(
	regionId: RegionId,
	step: LearningPathStep | null,
): RegionPathStatus | null {
	if (!step) return null;
	if (step.completedRegionIds.includes(regionId)) return "done";
	if (regionId === step.currentRegionId) return "current";
	if (regionId === step.nextRegionId) return "next";
	return null;
}
