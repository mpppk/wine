import { getRegion } from "#/lib/wine/regions";
import { getAop, listAops } from "#/lib/wine/service";
import type { RegionId, Subregion } from "#/lib/wine/types";
import { buildAopSubregionKey, type ParsedQuestionKey } from "../keys";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 所属地区クイズ: 「「シャブリ」が属する地区はどれ？」
// 設問文の主語はそのAOPで、正解 = 所属する地区(subregion)。
// ディストラクタは同一地域の他地区。実在する地区が4つ未満の地域は4択にできず出題しない。
// 広域(regional)AOCは地理的に全域へ跨り「所属地区」が曖昧なため対象外
// (odd-one-out の subregion 軸と同じ扱い)。選択肢に出す地区は、村名/畑名/シャトーが
// 属する実地区に限る(「地方名AOC(広域)」のような広域AOCの受け皿カテゴリは除外)。

/** 出題対象になりうるAOP(=地区が確定する村名/畑名/シャトー) */
function isScopedToSubregion(kind: string): boolean {
	return kind === "village" || kind === "vineyard" || kind === "winery";
}

/** 村名/畑名/シャトーが実在する地区だけ(広域AOCの受け皿カテゴリを除く) */
function realSubregions(regionId: RegionId): Subregion[] {
	const populated = new Set(
		listAops({ regionId })
			.filter((a) => isScopedToSubregion(a.kind))
			.map((a) => a.subregionId),
	);
	return (getRegion(regionId)?.subregions ?? []).filter((s) =>
		populated.has(s.id),
	);
}

export function enumerateAopSubregionKeys(regionId: RegionId): string[] {
	const subregions = realSubregions(regionId);
	if (subregions.length < 4) return []; // 正解+ディストラクタ3件を作れない
	const subregionIds = new Set(subregions.map((s) => s.id));
	return listAops({ regionId })
		.filter(
			(a) => isScopedToSubregion(a.kind) && subregionIds.has(a.subregionId),
		)
		.map((a) => buildAopSubregionKey(a.id));
}

export function materializeAopSubregionQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "aop-subregion" }>,
	rng: Rng,
): QuizQuestion | null {
	const aop = getAop(parsed.aopId);
	if (!aop || !isScopedToSubregion(aop.kind)) return null;

	const subregions = realSubregions(aop.region);
	const correct = subregions.find((s) => s.id === aop.subregionId);
	if (!correct) return null;

	const distractors = sample(
		subregions.filter((s) => s.id !== correct.id),
		3,
		rng,
	);
	if (distractors.length < 3) return null;

	const options = shuffle(
		[correct, ...distractors].map((s: Subregion) => ({
			id: s.id,
			label: s.nameJa,
		})),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	return {
		key: buildAopSubregionKey(aop.id),
		quizType: "aop-subregion",
		regionId: aop.region,
		prompt: `「${aop.nameJa}（${aop.shortName}）」が属する地区はどれ？`,
		options,
		correctOptionId: correct.id,
		explanation:
			`「${aop.nameJa}」は${correct.nameJa}に属します。` +
			`\n${aop.description}`,
		subjectAopId: aop.id,
	};
}
