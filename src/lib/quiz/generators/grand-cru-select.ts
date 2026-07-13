import { getRegion } from "#/lib/wine/regions";
import { getAop } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { buildGrandCruSelectKey, type ParsedQuestionKey } from "../keys";
import { aopOptionLabel } from "../labels";
import { type Rng, shuffle } from "../rng";
import type { QuizQuestion } from "../types";
import {
	grandCrusInSubregion,
	isGrandCruQuizRegion,
	nonGrandCrusInSubregion,
	pickPreferred,
	subregionNameJa,
} from "./grand-cru";

// ① 特級を選ぶクイズ: 「次のうち、シャブリのグラン・クリュ(特級)はどれ？」
// 正解1つが対象地区の特級、ディストラクタ3つが同地区の非特級。地区(subregion)は
// subject AOP の subregionId から一意に決まるためキーには含めない。
// ディストラクタは一級(premier-cru)を優先し(試験リアリティ)、足りなければ他の非特級で
// 補充する。正解がちょうど1つ(＝特級)であることは構成上保証される。

const DISTRACTOR_COUNT = 3;

export function enumerateGrandCruSelectKeys(regionId: RegionId): string[] {
	if (!isGrandCruQuizRegion(regionId)) return [];
	const keys: string[] = [];
	for (const subregion of getRegion(regionId)?.subregions ?? []) {
		const grandCrus = grandCrusInSubregion(regionId, subregion.id);
		const nonGrandCrus = nonGrandCrusInSubregion(regionId, subregion.id);
		if (grandCrus.length < 1 || nonGrandCrus.length < DISTRACTOR_COUNT)
			continue;
		for (const gc of grandCrus) {
			keys.push(buildGrandCruSelectKey(gc.id));
		}
	}
	return keys;
}

export function materializeGrandCruSelectQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "grand-cru-select" }>,
	rng: Rng,
): QuizQuestion | null {
	const answer = getAop(parsed.aopId);
	if (!answer || !isGrandCruQuizRegion(answer.region)) return null;

	// 正解が今も「その地区の特級リーフ」であることを再検証(データ更新でキーが古びた
	// 場合の防御)。傘AOC(Chablis Grand Cru 等)はリーフ判定で除かれる。
	const grandCrus = grandCrusInSubregion(answer.region, answer.subregionId);
	if (!grandCrus.some((a) => a.id === answer.id)) return null;

	const nonGrandCrus = nonGrandCrusInSubregion(
		answer.region,
		answer.subregionId,
	);
	const premier = nonGrandCrus.filter((a) => a.tags?.includes("premier-cru"));
	const other = nonGrandCrus.filter((a) => !a.tags?.includes("premier-cru"));
	const distractors = pickPreferred(premier, other, DISTRACTOR_COUNT, rng);
	if (distractors.length < DISTRACTOR_COUNT) return null;

	const options = shuffle(
		[answer, ...distractors].map((a) => ({ id: a.id, ...aopOptionLabel(a) })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	const subName = subregionNameJa(answer.region, answer.subregionId);
	const others = distractors.map((d) => `「${d.nameJa}」`).join("、");

	return {
		key: buildGrandCruSelectKey(answer.id),
		quizType: "grand-cru-select",
		regionId: answer.region,
		prompt: `次のうち、${subName}のグラン・クリュ(特級)はどれ？`,
		options,
		correctOptionId: answer.id,
		explanation:
			`「${answer.nameJa}」は${subName}のグラン・クリュ(特級)です。` +
			`他の3つ(${others})は特級ではありません。\n${answer.description}`,
		subjectAopId: answer.id,
	};
}
