import { COLOR_LABELS_JA } from "#/lib/wine/terminology";
import { getAop } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import {
	duplicatesUmbrellaFact,
	isOpenEndedAppellation,
	listClosedListAops,
} from "../aop-pool";
import { buildColorsKey, type ParsedQuestionKey } from "../keys";
import { COLOR_ORDER, colorComboId, formatColorsJa } from "../labels";
import { type Rng, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 生産可能色クイズ: 「このAOPで認められているワインの色をすべて選ぶ」
// 複数選択式。正解 = 実データの colors の集合。候補は5色固定で、
// 正誤は完全一致でのみ判定する(部分点なし)。

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
	const correctIds = COLOR_ORDER.filter((c) => aop.colors.includes(c));
	const options = shuffle(
		// 選択肢は複数選択式なので単色表記にする。「赤のみ」のような「のみ」付きは
		// 単一選択の含意になり、複数選択ではおかしい(#599)。解説文の formatColorsJa
		// （単色AOPなら「赤のみ」）は事実の叙述なので変えない。
		COLOR_ORDER.map((color) => ({
			id: color,
			label: COLOR_LABELS_JA[color],
		})),
		rng,
	);

	return {
		key: buildColorsKey(aop.id),
		quizType: "colors",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」で認められているワインの色(タイプ)をすべて選んでください`,
		options,
		correctOptionId: correctCombo,
		selectionKind: "multi",
		correctOptionIds: correctIds,
		explanation:
			`「${aop.nameJa}」で認められているのは「${formatColorsJa(aop.colors)}」です。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
