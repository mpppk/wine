import { getRegion } from "#/lib/wine/regions";
import { getAop } from "#/lib/wine/service";
import { aopClassificationLabel } from "#/lib/wine/tags";
import type { RegionId } from "#/lib/wine/types";
import { buildGrandCruOddKey, type ParsedQuestionKey } from "../keys";
import { aopOptionLabel } from "../labels";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";
import {
	grandCrusInSubregion,
	isGrandCruQuizRegion,
	premierCrusInSubregion,
	subregionNameJa,
} from "./grand-cru";

// ② 特級の仲間外れクイズ: 「次のうち、シャブリのグラン・クリュ(特級)でないものはどれ？」
// 4択のうち3つが対象地区の特級、正解1つが同地区の非特級(一級)。「特級に見えて特級で
// ない引っ掛け」を成立させるため、正解は一級(premier-cru)に限定する — シャブリなら
// 一級クリマ、コート・ド・ニュイ/ボーヌなら一級区画を持つ村名AOC(ジュヴレ・シャンベルタン
// 等)で、いずれも "シャンベルタン(特級) vs ジュヴレ・シャンベルタン(村)" のような頻出の
// 混同を突ける。正解がちょうど1つ(＝非特級)であることは構成上保証される。

const DISTRACTOR_COUNT = 3;

export function enumerateGrandCruOddKeys(regionId: RegionId): string[] {
	if (!isGrandCruQuizRegion(regionId)) return [];
	const keys: string[] = [];
	for (const subregion of getRegion(regionId)?.subregions ?? []) {
		const grandCrus = grandCrusInSubregion(regionId, subregion.id);
		const premierCrus = premierCrusInSubregion(regionId, subregion.id);
		if (grandCrus.length < DISTRACTOR_COUNT || premierCrus.length < 1) continue;
		for (const answer of premierCrus) {
			keys.push(buildGrandCruOddKey(answer.id));
		}
	}
	return keys;
}

export function materializeGrandCruOddQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "grand-cru-odd" }>,
	rng: Rng,
): QuizQuestion | null {
	const answer = getAop(parsed.aopId);
	if (!answer || !isGrandCruQuizRegion(answer.region)) return null;

	// 正解が今も「その地区の一級(非特級)リーフ」であることを再検証(データ更新でキーが
	// 古びた場合の防御)。
	const premierCrus = premierCrusInSubregion(answer.region, answer.subregionId);
	if (!premierCrus.some((a) => a.id === answer.id)) return null;

	const grandCrus = grandCrusInSubregion(answer.region, answer.subregionId);
	const distractors = sample(grandCrus, DISTRACTOR_COUNT, rng);
	if (distractors.length < DISTRACTOR_COUNT) return null;

	const options = shuffle(
		[answer, ...distractors].map((a) => ({ id: a.id, ...aopOptionLabel(a) })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	const subName = subregionNameJa(answer.region, answer.subregionId);
	const label = aopClassificationLabel(answer);
	const others = distractors.map((d) => `「${d.nameJa}」`).join("、");

	return {
		key: buildGrandCruOddKey(answer.id),
		quizType: "grand-cru-odd",
		regionId: answer.region,
		prompt: `次のうち、${subName}のグラン・クリュ(特級)でないものはどれ？`,
		options,
		correctOptionId: answer.id,
		explanation:
			`「${answer.nameJa}」は${subName}のグラン・クリュではありません` +
			`${label ? `(${label})` : ""}。他の3つ(${others})はいずれも特級です。` +
			`\n${answer.description}`,
		subjectAopId: answer.id,
	};
}
