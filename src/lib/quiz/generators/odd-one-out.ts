import { getRegion } from "#/lib/wine/regions";
import { aopAllowsGrape, getAop, listAops } from "#/lib/wine/service";
import { AOP_TAG_IDS, type AopTagId } from "#/lib/wine/tags";
import {
	type Aop,
	POLYGONLESS_IDAPP_MIN,
	type RegionId,
	type WineColor,
} from "#/lib/wine/types";
import { GRAPE_VARIETIES, getVariety } from "#/lib/wine/varieties";
import {
	buildOddOneOutKey,
	type OddOneOutAxis,
	type ParsedQuestionKey,
} from "../keys";
import {
	aopOptionLabel,
	COLOR_ORDER,
	COLOR_WINE_LABELS_JA,
	formatColorsJa,
} from "../labels";
import { type Rng, sample, shuffle } from "../rng";
import type { QuizQuestion } from "../types";

// 仲間外れクイズ: 4択のうち3つが性質を持ち、1つ(正解)だけが持たない。
// 「プール側が性質を持ち、正解側が持たない」ことがキー列挙の条件なので、
// 正解がちょうど1つであることは構成的に保証される。
//
// 軸: color(色) / grape(品種) / subregion(所属地区) / tag(格付け)

const MIN_POOL = 3;

// クリマ・合成総称ノード(ポリゴンを持たない詳細エントリ = idApp>=930000)は
// 仲間外れクイズの出題主体・選択肢にしない。数が多く難度が跳ねるうえ、地図クイズ
// (重心依存)では自動除外される一方、仲間外れは非依存なのでここで明示的に除く。
const listQuizAops: typeof listAops = (filter) =>
	listAops(filter).filter((a) => a.idApp < POLYGONLESS_IDAPP_MIN);

/** 軸ごとの「性質を持つ側のプール」。3件未満なら問題が成立しない */
function poolFor(
	regionId: RegionId,
	axis: string,
	axisValue: string,
): Aop[] | null {
	switch (axis) {
		case "color":
			return listQuizAops({ regionId }).filter((a) =>
				a.colors.includes(axisValue as WineColor),
			);
		case "grape":
			return listQuizAops({ regionId }).filter((a) =>
				aopAllowsGrape(a, axisValue),
			);
		case "subregion":
			// 広域(regional)AOCは地理的に全域へ跨り「属さない」の判定が曖昧なため、
			// 村名・畑名に両側を限定する
			return listQuizAops({ regionId, subregionId: axisValue }).filter(
				(a) => a.kind === "village" || a.kind === "vineyard",
			);
		case "tag":
			if (axisValue === "premier-cru") {
				// 一級は村名同士で比較する(畑名の一級は文脈が異なる)
				return listQuizAops({ regionId, kind: "village" }).filter((a) =>
					a.tags?.includes("premier-cru"),
				);
			}
			return listQuizAops({ regionId }).filter((a) =>
				a.tags?.includes(axisValue as AopTagId),
			);
		default:
			return null;
	}
}

/** 軸ごとの「性質を持たない側(=正解候補)」 */
function answersFor(
	regionId: RegionId,
	axis: string,
	axisValue: string,
): Aop[] {
	switch (axis) {
		case "color":
			return listQuizAops({ regionId }).filter(
				(a) => !a.colors.includes(axisValue as WineColor),
			);
		case "grape":
			return listQuizAops({ regionId }).filter(
				(a) => !aopAllowsGrape(a, axisValue),
			);
		case "subregion":
			return listQuizAops({ regionId })
				.filter((a) => a.kind === "village" || a.kind === "vineyard")
				.filter((a) => a.subregionId !== axisValue);
		case "tag":
			if (axisValue === "premier-cru") {
				// 特級村を「一級でない」と扱うのは紛らわしいため正解候補から外す
				return listQuizAops({ regionId, kind: "village" }).filter(
					(a) =>
						!a.tags?.includes("premier-cru") && !a.tags?.includes("grand-cru"),
				);
			}
			return listQuizAops({ regionId }).filter(
				(a) =>
					(a.kind === "village" || a.kind === "vineyard") &&
					!a.tags?.includes(axisValue as AopTagId),
			);
		default:
			return [];
	}
}

export function enumerateOddOneOutKeys(regionId: RegionId): string[] {
	const keys: string[] = [];
	const axisValues: [OddOneOutAxis, string[]][] = [
		["color", [...COLOR_ORDER]],
		["grape", GRAPE_VARIETIES.map((v) => v.id)],
		["subregion", (getRegion(regionId)?.subregions ?? []).map((s) => s.id)],
		["tag", [...AOP_TAG_IDS]],
	];
	for (const [axis, values] of axisValues) {
		for (const value of values) {
			const pool = poolFor(regionId, axis, value);
			if (!pool || pool.length < MIN_POOL) continue;
			for (const answer of answersFor(regionId, axis, value)) {
				keys.push(buildOddOneOutKey(axis, value, answer.id));
			}
		}
	}
	return keys;
}

function promptFor(axis: string, axisValue: string, answer: Aop): string {
	switch (axis) {
		case "color":
			return `次のうち、${COLOR_WINE_LABELS_JA[axisValue as WineColor]}の生産が認められていないAOPはどれ？`;
		case "grape":
			return `次のうち、「${getVariety(axisValue)?.nameJa}」の使用が認められていないAOPはどれ？`;
		case "subregion": {
			const subregion = getRegion(answer.region)?.subregions.find(
				(s) => s.id === axisValue,
			);
			return `次のうち、${subregion?.nameJa}に属さないAOPはどれ？`;
		}
		case "tag":
			if (axisValue === "premier-cru") {
				return answer.region === "champagne"
					? "次のうち、プルミエ・クリュ(一級)に格付けされた村でないのはどれ？"
					: "次のうち、プルミエ・クリュ(1er Cru)の区画を持たない村名AOCはどれ？";
			}
			return "次のうち、グラン・クリュ(特級)に格付けされていないAOPはどれ？";
		default:
			return "";
	}
}

function explanationFor(
	axis: string,
	axisValue: string,
	answer: Aop,
	distractors: Aop[],
): string {
	const others = distractors.map((d) => `「${d.nameJa}」`).join("、");
	let fact: string;
	switch (axis) {
		case "color":
			fact =
				`「${answer.nameJa}」で認められているのは「${formatColorsJa(answer.colors)}」で、` +
				`${COLOR_WINE_LABELS_JA[axisValue as WineColor]}は含まれません。` +
				`他の3つ(${others})はいずれも${COLOR_WINE_LABELS_JA[axisValue as WineColor]}の生産が認められています。`;
			break;
		case "grape": {
			const varietyName = getVariety(axisValue)?.nameJa;
			const allowed = answer.grapes
				.map((g) => getVariety(g.varietyId)?.nameJa)
				.filter(Boolean)
				.join("、");
			fact =
				`「${answer.nameJa}」で使用できる品種は${allowed}で、${varietyName}は含まれません。` +
				`他の3つ(${others})はいずれも${varietyName}の使用が認められています。`;
			break;
		}
		case "subregion": {
			const region = getRegion(answer.region);
			const subregionName = region?.subregions.find(
				(s) => s.id === axisValue,
			)?.nameJa;
			const answerSubregionName = region?.subregions.find(
				(s) => s.id === answer.subregionId,
			)?.nameJa;
			fact =
				`「${answer.nameJa}」は${answerSubregionName}のAOPです。` +
				`他の3つ(${others})はいずれも${subregionName}に属します。`;
			break;
		}
		case "tag":
			if (axisValue === "premier-cru") {
				fact =
					answer.region === "champagne"
						? `「${answer.nameJa}」はプルミエ・クリュに格付けされていません。他の3つ(${others})はいずれも一級村です。`
						: `「${answer.nameJa}」には1er Cruの区画がありません。他の3つ(${others})はいずれも1er Cruの区画を持つ村名AOCです。`;
			} else {
				fact = `「${answer.nameJa}」はグラン・クリュには格付けされていません。他の3つ(${others})はいずれも特級です。`;
			}
			break;
		default:
			fact = "";
	}
	return `${fact}\n${answer.description}`;
}

export function materializeOddOneOutQuestion(
	parsed: Extract<ParsedQuestionKey, { quizType: "odd-one-out" }>,
	rng: Rng,
): QuizQuestion | null {
	const answer = getAop(parsed.aopId);
	if (!answer) return null;
	const pool = poolFor(answer.region, parsed.axis, parsed.axisValue);
	if (!pool || pool.length < MIN_POOL) return null;
	// 正解が本当に性質を欠いていることを再検証(データ更新でキーが古びた場合の防御)
	if (
		!answersFor(answer.region, parsed.axis, parsed.axisValue).some(
			(a) => a.id === answer.id,
		)
	) {
		return null;
	}

	const distractors = sample(pool, 3, rng);
	if (distractors.length < 3) return null;

	const options = shuffle(
		[answer, ...distractors].map((a) => ({ id: a.id, ...aopOptionLabel(a) })),
		rng,
	);
	if (new Set(options.map((o) => o.id)).size !== 4) return null;

	return {
		key: buildOddOneOutKey(parsed.axis, parsed.axisValue, answer.id),
		quizType: "odd-one-out",
		regionId: answer.region,
		prompt: promptFor(parsed.axis, parsed.axisValue, answer),
		options,
		correctOptionId: answer.id,
		explanation: explanationFor(
			parsed.axis,
			parsed.axisValue,
			answer,
			distractors,
		),
		subjectAopId: answer.id,
	};
}
