import { AOPS } from "#/lib/wine/aops-data";
import { getAop } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import {
	duplicatesUmbrellaFact,
	isOpenEndedAppellation,
	listClosedListAops,
} from "../aop-pool";
import { buildColorsKey, type ParsedQuestionKey } from "../keys";
import { colorComboId, formatColorsJa } from "../labels";
import { type Rng, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 生産可能色クイズ: 「このAOPで認められているワインの色は？」
// 正解 = 実データの colors。ディストラクタは全データに実在する色コンボから
// 正解と紛らわしい(対称差が小さい)ものを優先して選ぶため、
// ありえない不自然な組み合わせは選択肢に出ない。

/** 全AOPに実在する色コンボ(遅延計算・以後不変) */
let existingCombos: string[] | undefined;
function listExistingCombos(): string[] {
	if (!existingCombos) {
		existingCombos = [...new Set(AOPS.map((a) => colorComboId(a.colors)))];
	}
	return existingCombos;
}

/** 正解の色コンボが上位AOP(傘AOC/村)と同じ畑は、上位側の1問に集約する(aop-pool.ts 参照) */
const duplicatesUmbrellaColors = (a: Aop) =>
	duplicatesUmbrellaFact(a, (x) =>
		// IGT は本形式の出題対象外(集約先になれない)
		isOpenEndedAppellation(x) ? undefined : colorComboId(x.colors),
	);

// 開かれた広域呼称(IGT)は収録した colors が網羅でないため、「認められている色は」を
// 断定するこの形式では出題しない(aop-pool.ts 参照)
export function enumerateColorsKeys(regionId: RegionId): string[] {
	return listClosedListAops({ regionId })
		.filter((a) => !duplicatesUmbrellaColors(a))
		.map((a) => buildColorsKey(a.id));
}

export function materializeColorsQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "colors" }>,
	rng: Rng,
): QuizQuestion | null {
	const aop = getAop(parsed.aopId);
	if (!aop || isOpenEndedAppellation(aop) || duplicatesUmbrellaColors(aop)) {
		return null;
	}

	const correctCombo = colorComboId(aop.colors);
	const comboColors = (combo: string) => combo.split("+");
	const symmetricDiff = (combo: string) => {
		const a = new Set(comboColors(combo));
		const b = new Set(comboColors(correctCombo));
		let diff = 0;
		for (const c of a) if (!b.has(c)) diff++;
		for (const c of b) if (!a.has(c)) diff++;
		return diff;
	};
	// シャッフル後に安定ソートすることで、対称差の同点内はランダムになる
	const distractors = shuffle(
		listExistingCombos().filter((c) => c !== correctCombo),
		rng,
	)
		.sort((a, b) => symmetricDiff(a) - symmetricDiff(b))
		.slice(0, 3);
	if (distractors.length < 3) return null;

	const options = shuffle(
		[correctCombo, ...distractors].map((combo) => ({
			id: combo,
			label: formatColorsJa(combo.split("+") as typeof aop.colors),
		})),
		rng,
	);

	return {
		key: buildColorsKey(aop.id),
		quizType: "colors",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」で認められているワインの色(タイプ)は？`,
		options,
		correctOptionId: correctCombo,
		explanation:
			`「${aop.nameJa}」で認められているのは「${formatColorsJa(aop.colors)}」です。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
