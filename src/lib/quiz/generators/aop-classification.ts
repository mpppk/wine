import { AOPS } from "#/lib/wine/aops-data";
import { getAop, listAops } from "#/lib/wine/service";
import { aopClassificationLabel } from "#/lib/wine/tags";
import type { RegionId } from "#/lib/wine/types";
import { buildAopClassificationKey, type ParsedQuestionKey } from "../keys";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 格付けクイズ: 「「シャンベルタン」の格付けは？」
// 設問文の主語はそのAOPで、正解 = そのAOPの格付けラベル(特級 / 1er Cruあり /
// 第2級(1855) / DOCG など、地域の制度に応じた文脈依存ラベル)。
// 格付けタグを持つAOPだけを主題にする(タグ無しAOPは「格付けなし」となり曖昧なため除外)。
// ディストラクタは同一地域に実在する他ラベルを優先し、足りなければ全データの
// ラベルで補う。制度をまたぐラベルが混じっても「実在する格付けラベル」から選ぶため
// 不自然な選択肢にはならない。

/** 全AOPに実在する格付けラベル(遅延計算・以後不変) */
let globalLabels: string[] | undefined;
function listGlobalLabels(): string[] {
	if (!globalLabels) {
		globalLabels = [
			...new Set(
				AOPS.map((a) => aopClassificationLabel(a)).filter(
					(l): l is string => l !== undefined,
				),
			),
		];
	}
	return globalLabels;
}

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
	// 4択(正解+3ラベル)を作れるだけの実在ラベルが全体にあることを前提にする
	if (listGlobalLabels().length < 4) return [];
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

	// 同一地域の他ラベルを優先し、3件に満たなければ全データのラベルで補う
	const regionPool = listRegionLabels(aop.region).filter((l) => l !== correct);
	const pool =
		regionPool.length >= 3
			? regionPool
			: [...new Set([...regionPool, ...listGlobalLabels()])].filter(
					(l) => l !== correct,
				);
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
