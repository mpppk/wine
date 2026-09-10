import { getAop } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import { GRAPE_VARIETY_IDS, getVariety } from "#/lib/wine/varieties";
import {
	duplicatesUmbrellaFact,
	isOpenEndedAppellation,
	listClosedListAops,
} from "../aop-pool";
import { buildAopVarietyKey, type ParsedQuestionKey } from "../keys";
import {
	formatPrincipalGrapesJa,
	principalComboId,
	principalVarietyIds,
} from "../labels";
import { type Rng, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 主要品種クイズ: 「「シャブリ」の主要品種をすべて選ぶ」
// 複数選択式。正解 = 実データの principal(主要品種)の集合。候補は
// その地域の主要品種パレット(同一地域の収録AOPが主要品種に持つ品種の和集合)で、
// 正誤は完全一致でのみ判定する(部分点なし)。

/** 地域の主要品種パレット(品種マスタの定義順)。候補一覧に使う */
function listRegionPalette(regionId: RegionId): string[] {
	const ids = new Set<string>();
	for (const aop of listClosedListAops({ regionId })) {
		for (const id of principalVarietyIds(aop)) ids.add(id);
	}
	return GRAPE_VARIETY_IDS.filter((id) => ids.has(id));
}
/** 正解の主要品種コンボが上位AOP(傘AOC/村)と同じ畑は、上位側の1問に集約する(aop-pool.ts 参照) */
const duplicatesUmbrellaVariety = (a: Aop) =>
	duplicatesUmbrellaFact(a, (x) =>
		// IGT は本形式の出題対象外(集約先になれない)。主要品種を持たないAOPは
		// principalComboId が "" を返し、集約されない(aop-pool.ts 参照)
		isOpenEndedAppellation(x) ? undefined : principalComboId(x),
	);

export function enumerateAopVarietyKeys(regionId: RegionId): string[] {
	// 主要品種を持ち、かつ候補パレットが2件以上ある場合のみ出題。
	// 開かれた広域呼称(IGT)は「主要品種」が定まらないため除く(aop-pool.ts 参照)
	if (listRegionPalette(regionId).length < 2) return [];
	return listClosedListAops({ regionId })
		.filter(
			(a) => principalVarietyIds(a).length > 0 && !duplicatesUmbrellaVariety(a),
		)
		.map((a) => buildAopVarietyKey(a.id));
}

export function materializeAopVarietyQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "aop-variety" }>,
	rng: Rng,
): QuizQuestion | null {
	const aop = getAop(parsed.aopId);
	if (!aop || isOpenEndedAppellation(aop) || duplicatesUmbrellaVariety(aop)) {
		return null;
	}

	const correctCombo = principalComboId(aop);
	if (correctCombo.length === 0) return null;
	const correctIds = principalVarietyIds(aop);

	const options = shuffle(
		listRegionPalette(aop.region).map((id) => ({
			id,
			label: getVariety(id)?.nameJa ?? id,
		})),
		rng,
	);
	if (options.length < 2) return null;

	return {
		key: buildAopVarietyKey(aop.id),
		quizType: "aop-variety",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」の主要品種をすべて選んでください`,
		options,
		correctOptionId: correctCombo,
		selectionKind: "multi",
		correctOptionIds: correctIds,
		explanation:
			`「${aop.nameJa}」の主要品種は${formatPrincipalGrapesJa(correctCombo)}です。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
