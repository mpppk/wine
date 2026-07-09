import { getCentroid } from "#/lib/wine/centroids";
import { getRegion } from "#/lib/wine/regions";
import { getAop, listAops } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import {
	buildLocationKey,
	LOCATION_DIRECTIONS,
	type LocationDirection,
	type ParsedQuestionKey,
} from "../keys";
import { aopOptionLabel } from "../labels";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 位置関係クイズ: 「コート・ド・ニュイの村名AOPのうち最も北にあるのはどれ？」
// 同一サブリージョンの村名AOPを、区画の面積加重セントロイド(aop-centroids.json)で
// 南北(緯度)・東西(経度)比較する。ディストラクタは正解より MIN_GAP 以上
// 反対側にある村だけを採用するため、僅差の曖昧な問題は構造的に生成されない。
// 東西方向もサポートすることで、東西に延びる地区(ヴァレ・ド・ラ・マルヌ等)も
// 分離の良い軸で出題できる。
// 村名AOCを持たない地域(アルザス等)では、畑名AOP(グラン・クリュ)を
// 同じルールで比較して出題する。選択肢の区分は1問の中で混ぜない。

/** 出題に必要な最小の座標差。約1.1km(緯度0.010° / 経度0.015° @47°N) */
const MIN_GAP_LAT = 0.01;
const MIN_GAP_LNG = 0.015;

const DIRECTION_LABELS_JA: Record<LocationDirection, string> = {
	north: "北",
	south: "南",
	east: "東",
	west: "西",
};

/** direction の軸の座標値。値が大きいほど「極側」になるよう符号を揃える */
function axisValue(aop: Aop, direction: LocationDirection): number | undefined {
	const centroid = getCentroid(aop.id);
	if (!centroid) return undefined;
	const [lng, lat] = centroid;
	switch (direction) {
		case "north":
			return lat;
		case "south":
			return -lat;
		case "east":
			return lng;
		case "west":
			return -lng;
	}
}

function minGap(direction: LocationDirection): number {
	return direction === "north" || direction === "south"
		? MIN_GAP_LAT
		: MIN_GAP_LNG;
}

function locationPoolIn(regionId: RegionId, subregionId: string): Aop[] {
	const villages = listAops({ regionId, subregionId, kind: "village" }).filter(
		(a) => getCentroid(a.id) !== undefined,
	);
	if (villages.length > 0) return villages;
	// 村名AOCが無い地区(アルザスのバ・ラン/オー・ラン等)は畑名AOPで比較する
	return listAops({ regionId, subregionId, kind: "vineyard" }).filter(
		(a) => getCentroid(a.id) !== undefined,
	);
}

/** subject より MIN_GAP 以上「反対側」にあるAOP(=ディストラクタ候補) */
function distractorPoolFor(
	subject: Aop,
	pool: Aop[],
	direction: LocationDirection,
): Aop[] {
	const subjectValue = axisValue(subject, direction);
	if (subjectValue === undefined) return [];
	const gap = minGap(direction);
	return pool.filter((v) => {
		if (v.id === subject.id) return false;
		const value = axisValue(v, direction);
		return value !== undefined && subjectValue - value >= gap;
	});
}

export function enumerateLocationKeys(regionId: RegionId): string[] {
	const keys: string[] = [];
	for (const subregion of getRegion(regionId)?.subregions ?? []) {
		const pool = locationPoolIn(regionId, subregion.id);
		if (pool.length < 4) continue;
		for (const direction of LOCATION_DIRECTIONS) {
			for (const subject of pool) {
				if (distractorPoolFor(subject, pool, direction).length >= 3) {
					keys.push(buildLocationKey(direction, subregion.id, subject.id));
				}
			}
		}
	}
	return keys;
}

export function materializeLocationQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "location" }>,
	rng: Rng,
): QuizQuestion | null {
	const subject = getAop(parsed.aopId);
	if (
		(subject?.kind !== "village" && subject?.kind !== "vineyard") ||
		subject.subregionId !== parsed.subregionId
	) {
		return null;
	}
	const region = getRegion(subject.region);
	const subregion = region?.subregions.find((s) => s.id === parsed.subregionId);
	if (!subregion) return null;

	const candidates = locationPoolIn(subject.region, parsed.subregionId);
	// 村がある地区で畑が主題になる(またはその逆)キーは無効として弾く
	if (!candidates.some((a) => a.id === subject.id)) return null;
	const pool = distractorPoolFor(subject, candidates, parsed.direction);
	const distractors = sample(pool, 3, rng);
	if (distractors.length < 3) return null;

	const chosen = [subject, ...distractors];
	const options = shuffle(
		chosen.map((a) => ({ id: a.id, ...aopOptionLabel(a) })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	// 解説: 4択を軸の極側から整列(南北軸は北から、東西軸は東から)
	const sortAxis: LocationDirection =
		parsed.direction === "north" || parsed.direction === "south"
			? "north"
			: "east";
	const ordered = [...chosen].sort(
		(a, b) => (axisValue(b, sortAxis) ?? 0) - (axisValue(a, sortAxis) ?? 0),
	);
	const orderLabel = sortAxis === "north" ? "北" : "東";
	const orderLine = ordered.map((a) => a.nameJa).join(" → ");

	return {
		key: buildLocationKey(parsed.direction, parsed.subregionId, subject.id),
		quizType: "location",
		regionId: subject.region,
		prompt: `次の${subregion.nameJa}の${subject.kind === "village" ? "村名AOP" : "畑名AOP"}のうち、最も${DIRECTION_LABELS_JA[parsed.direction]}にあるのはどれ？`,
		options,
		correctOptionId: subject.id,
		explanation:
			`${orderLabel}から順に: ${orderLine}（AOP区画の重心位置の比較によります）。` +
			`\n${subject.description}`,
		subjectAopId: subject.id,
	};
}
