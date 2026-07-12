import { getAop, listAops } from "#/lib/wine/service";
import { aopClassificationLabel } from "#/lib/wine/tags";
import type { RegionId } from "#/lib/wine/types";
import { buildAopClassificationKey, type ParsedQuestionKey } from "../keys";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 格付けクイズ: 「「シャトー・マルゴー」の格付けは？」
// 設問文の主語はそのAOPで、正解 = そのAOPの格付けラベル(第1級(1855年) など、
// 地域の格付け制度に応じた文脈依存ラベル)。
// 格付けタグを持つAOPだけを主題にする(タグ無しAOPは「格付けなし」となり曖昧なため除外)。
//
// ディストラクタは「同一地域(=同一格付け制度)に実在する他ラベル」だけから選ぶ。
// 制度をまたぐ補充はしない: ブルゴーニュの村名(正解「1er Cruあり」)にボルドーの
// 「第1級(1855年)」を混ぜると、ブルゴーニュ画面ではプルミエ・クリュを「一級」と
// 読ませているため読みが衝突し、不公正な設問になる。このため自地域だけで4択
// (正解+3ディストラクタ)を作れる地域(=実在ラベルが4種以上)だけを出題対象にする。
// 現状ではボルドー(8ラベル)のみが該当し、ラベル数の少ないブルゴーニュ/シャンパーニュ/
// アルザス/ピエモンテは本形式から外れる(これらの地域は他形式のクイズで扱う)。

/** 4択(正解+3ディストラクタ)を同一制度内で作れる実在ラベル数の下限 */
const MIN_REGION_LABELS = 4;

/** 指定地域に実在する格付けラベル */
function listRegionLabels(regionId: RegionId): string[] {
	return [
		...new Set(
			listAops({ regionId })
				.map((a) => aopClassificationLabel(a))
				.filter((l): l is string => l !== undefined),
		),
	];
}

export function enumerateAopClassificationKeys(regionId: RegionId): string[] {
	// 自地域だけで4択を作れる地域(=実在ラベルが4種以上)だけ出題する。
	// 足りない地域は制度をまたぐ不自然な選択肢になるため本形式では出題しない。
	if (listRegionLabels(regionId).length < MIN_REGION_LABELS) return [];
	return listAops({ regionId })
		.filter((a) => aopClassificationLabel(a) !== undefined)
		.map((a) => buildAopClassificationKey(a.id));
}

export function materializeAopClassificationQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "aop-classification" }>,
	rng: Rng,
): QuizQuestion | null {
	const aop = getAop(parsed.aopId);
	if (!aop) return null;
	const correct = aopClassificationLabel(aop);
	if (!correct) return null;

	// 同一地域(=同一格付け制度)のラベルだけからディストラクタを選ぶ。制度をまたぐ
	// 補充はしない(読みが衝突して不公正な設問になるため)。3件に満たなければ出題しない。
	const pool = listRegionLabels(aop.region).filter((l) => l !== correct);
	const distractors = sample(pool, 3, rng);
	if (distractors.length < 3) return null;

	const options = shuffle(
		[correct, ...distractors].map((label) => ({ id: label, label })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	return {
		key: buildAopClassificationKey(aop.id),
		quizType: "aop-classification",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」の格付けはどれ？`,
		options,
		correctOptionId: correct,
		explanation:
			`「${aop.nameJa}」の格付けは「${correct}」です。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
