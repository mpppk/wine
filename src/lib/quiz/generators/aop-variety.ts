import { AOPS } from "#/lib/wine/aops-data";
import { getAop } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
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

// 主要品種クイズ: 「「シャブリ」の主要品種はどれ？」
// 設問文の主語はそのAOPで、正解 = 実データの principal(主要品種)コンボ。
// colors と同型で、ディストラクタは全データに実在する主要品種コンボから
// 正解と紛らわしい(対称差が小さい)ものを優先して選ぶため、
// ありえない不自然な組み合わせは選択肢に出ない。

/** 全AOPに実在する主要品種コンボ(遅延計算・以後不変) */
let existingCombos: string[] | undefined;
function listExistingCombos(): string[] {
	if (!existingCombos) {
		existingCombos = [
			...new Set(
				AOPS.map((a) => principalComboId(a)).filter((c) => c.length > 0),
			),
		];
	}
	return existingCombos;
}

/** 正解の主要品種コンボが上位AOP(傘AOC/村)と同じ畑は、上位側の1問に集約する(aop-pool.ts 参照) */
const duplicatesUmbrellaVariety = (a: Aop) =>
	duplicatesUmbrellaFact(a, (x) =>
		// IGT は本形式の出題対象外(集約先になれない)。主要品種を持たないAOPは
		// principalComboId が "" を返し、集約されない(aop-pool.ts 参照)
		isOpenEndedAppellation(x) ? undefined : principalComboId(x),
	);

export function enumerateAopVarietyKeys(regionId: RegionId): string[] {
	// 主要品種を持ち、かつ4択を作れる(実在コンボが4種以上ある)場合のみ出題。
	// 開かれた広域呼称(IGT)は「主要品種」が定まらないため除く(aop-pool.ts 参照)
	if (listExistingCombos().length < 4) return [];
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

	const comboGrapes = (combo: string) => combo.split("+");
	const symmetricDiff = (combo: string) => {
		const a = new Set(comboGrapes(combo));
		const b = new Set(comboGrapes(correctCombo));
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
			label: formatPrincipalGrapesJa(combo),
		})),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	return {
		key: buildAopVarietyKey(aop.id),
		quizType: "aop-variety",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」の主要品種はどれ？`,
		options,
		correctOptionId: correctCombo,
		explanation:
			`「${aop.nameJa}」の主要品種は${formatPrincipalGrapesJa(correctCombo)}です。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
