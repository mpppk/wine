import { getRegion } from "#/lib/wine/regions";
import { listAops } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import { type Rng, sample } from "../rng";

// 地区別グラン・クリュ(特級)クイズの共有ロジック。
// 「①特級を選ぶ(grand-cru-select) / ②特級でないものを選ぶ(grand-cru-odd)」の両
// ジェネレータが、地区(subregion)内の特級/非特級の候補集合をここから得る。
// 全て静的AOPデータ上の純関数。
//
// 出題対象地域: 現状ブルゴーニュのみ。他地域(シャンパーニュの特級村、アルザスの
// 特級リュー・ディ等)へ広げる場合は「地区スコープの妥当性」「選択肢が試験として
// 成立するか」を地域ごとに検証する必要があるため、ここで明示的にゲートしている。
// この集合を緩めれば拡張できる。
export const GRAND_CRU_QUIZ_REGIONS: ReadonlySet<RegionId> = new Set<RegionId>([
	"bourgogne",
]);

export function isGrandCruQuizRegion(regionId: RegionId): boolean {
	return GRAND_CRU_QUIZ_REGIONS.has(regionId);
}

/**
 * 地区内AOPのうち「傘ノード(=同一地区の他エントリの parentAopId に参照される総称
 * AOC)」を除いたリーフ。シャブリでは総称の "Chablis Grand Cru" / "Chablis Premier
 * Cru" を除き、実際の区画(クリマ)だけを残す — これにより「レ・クロ vs モンテ・ド・
 * トネール」のように試験本番と同じ粒度で出題できる。コート・ド・ニュイ等は傘ノードが
 * 無いため畑AOC・村名AOCがそのまま残る。
 */
function leafAopsInSubregion(regionId: RegionId, subregionId: string): Aop[] {
	const aops = listAops({ regionId, subregionId });
	const parentIds = new Set(
		aops
			.map((a) => a.parentAopId)
			.filter((id): id is string => id !== undefined),
	);
	return aops.filter((a) => !parentIds.has(a.id));
}

/** 地区内の特級リーフ */
export function grandCrusInSubregion(
	regionId: RegionId,
	subregionId: string,
): Aop[] {
	return leafAopsInSubregion(regionId, subregionId).filter((a) =>
		a.tags?.includes("grand-cru"),
	);
}

/** 地区内の非特級リーフ(①のディストラクタ母集団) */
export function nonGrandCrusInSubregion(
	regionId: RegionId,
	subregionId: string,
): Aop[] {
	return leafAopsInSubregion(regionId, subregionId).filter(
		(a) => !a.tags?.includes("grand-cru"),
	);
}

/**
 * 地区内の「一級(premier-cru)の非特級リーフ」。②の正解(=特級に見えて特級でない
 * 引っ掛け)はここに限定する。シャブリなら一級クリマ、コート・ド・ニュイ/ボーヌなら
 * 一級区画を持つ村名AOC(ジュヴレ・シャンベルタン等)が入り、いずれも aopClassificationLabel が
 * 意味のあるラベルを返す。
 */
export function premierCrusInSubregion(
	regionId: RegionId,
	subregionId: string,
): Aop[] {
	return nonGrandCrusInSubregion(regionId, subregionId).filter((a) =>
		a.tags?.includes("premier-cru"),
	);
}

/** 地区の表示名(日本語) */
export function subregionNameJa(
	regionId: RegionId,
	subregionId: string,
): string | undefined {
	return getRegion(regionId)?.subregions.find((s) => s.id === subregionId)
		?.nameJa;
}

/**
 * ディストラクタを「優先プール」から取り、足りない分だけ「補充プール」から埋める。
 * 一級を優先しつつ、一級が3件に満たない地区でも他の非特級で成立させるために使う。
 */
export function pickPreferred<T>(
	preferred: readonly T[],
	fallback: readonly T[],
	count: number,
	rng: Rng,
): T[] {
	const chosen = sample(preferred, count, rng);
	if (chosen.length >= count) return chosen;
	return [...chosen, ...sample(fallback, count - chosen.length, rng)];
}
