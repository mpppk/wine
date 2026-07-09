import { aopAllowsGrape, getAop, listAops } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import { GRAPE_VARIETIES, getVariety } from "#/lib/wine/varieties";
import { buildVarietyKey, type ParsedQuestionKey } from "../keys";
import { aopOptionLabel } from "../labels";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 品種フォーカスクイズ: 「主に「ガメイ」から造られるAOPはどれ？」
// 正解 = その品種を principal(主要品種)に持つAOP。
// ディストラクタはその品種を補助品種としても「全く含まない」AOPに限定し、
// 「主に」の解釈の曖昧さを排除する。ピノ/シャルドネ偏重の地域では
// ディストラクタ3件を確保できない品種をスキップする(例: ボジョレーは0問)。

const MIN_DISTRACTOR_POOL = 3;

function distractorPoolFor(regionId: RegionId, varietyId: string): Aop[] {
	return listAops({ regionId }).filter((a) => !aopAllowsGrape(a, varietyId));
}

export function enumerateVarietyKeys(regionId: RegionId): string[] {
	const keys: string[] = [];
	for (const variety of GRAPE_VARIETIES) {
		const pool = distractorPoolFor(regionId, variety.id);
		if (pool.length < MIN_DISTRACTOR_POOL) continue;
		const corrects = listAops({ regionId }).filter((a) =>
			a.grapes.some(
				(g) => g.varietyId === variety.id && g.role === "principal",
			),
		);
		for (const correct of corrects) {
			keys.push(buildVarietyKey(variety.id, correct.id));
		}
	}
	return keys;
}

function principalNames(aop: Aop): string {
	return aop.grapes
		.filter((g) => g.role === "principal")
		.map((g) => getVariety(g.varietyId)?.nameJa)
		.filter(Boolean)
		.join("、");
}

export function materializeVarietyQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "variety" }>,
	rng: Rng,
): QuizQuestion | null {
	const correct = getAop(parsed.aopId);
	const variety = getVariety(parsed.varietyId);
	if (!correct || !variety) return null;
	// 正解の再検証(データ更新でキーが古びた場合の防御)
	if (
		!correct.grapes.some(
			(g) => g.varietyId === variety.id && g.role === "principal",
		)
	) {
		return null;
	}

	const pool = distractorPoolFor(correct.region, variety.id);
	const distractors = sample(pool, 3, rng);
	if (distractors.length < 3) return null;

	const options = shuffle(
		[correct, ...distractors].map((a) => ({ id: a.id, ...aopOptionLabel(a) })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	const distractorLines = distractors
		.map((d) => `「${d.nameJa}」の主要品種は${principalNames(d)}です。`)
		.join("");

	return {
		key: buildVarietyKey(variety.id, correct.id),
		quizType: "variety",
		regionId: correct.region,
		prompt: `次のうち、主に「${variety.nameJa}」から造られるAOPはどれ？`,
		options,
		correctOptionId: correct.id,
		explanation:
			`「${correct.nameJa}」の主要品種は${principalNames(correct)}です。` +
			`${distractorLines}\n${correct.description}`,
		subjectAopId: correct.id,
	};
}
