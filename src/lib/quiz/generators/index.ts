import { getAop } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { parseKey } from "../keys";
import type { Rng } from "../rng";
import {
	AOP_ANSWER_QUIZ_TYPES,
	QUIZ_TYPE_IDS,
	type QuizQuestion,
	type QuizType,
} from "../types";
import {
	enumerateAopClassificationKeys,
	materializeAopClassificationQuestion,
} from "./aop-classification";
import {
	enumerateAopSubregionKeys,
	materializeAopSubregionQuestion,
} from "./aop-subregion";
import {
	enumerateAopVarietyKeys,
	materializeAopVarietyQuestion,
} from "./aop-variety";
import { enumerateColorsKeys, materializeColorsQuestion } from "./colors";
import {
	enumerateGrandCruOddKeys,
	materializeGrandCruOddQuestion,
} from "./grand-cru-odd";
import {
	enumerateGrandCruSelectKeys,
	materializeGrandCruSelectQuestion,
} from "./grand-cru-select";
import { enumerateLocationKeys, materializeLocationQuestion } from "./location";
import {
	enumerateOddOneOutKeys,
	materializeOddOneOutQuestion,
} from "./odd-one-out";
import { enumerateVarietyKeys, materializeVarietyQuestion } from "./variety";

// ジェネレータのレジストリ。スケジューラは listCandidates で候補キーを列挙し、
// 選ばれたキーを materializeQuestion で4択に具現化する。
// 静的AOPデータ上の純関数のみで構成され、D1に依存しない。

const ENUMERATORS: Record<QuizType, (regionId: RegionId) => string[]> = {
	colors: enumerateColorsKeys,
	"aop-variety": enumerateAopVarietyKeys,
	"aop-subregion": enumerateAopSubregionKeys,
	"aop-classification": enumerateAopClassificationKeys,
	"grand-cru-select": enumerateGrandCruSelectKeys,
	"grand-cru-odd": enumerateGrandCruOddKeys,
	"odd-one-out": enumerateOddOneOutKeys,
	variety: enumerateVarietyKeys,
	location: enumerateLocationKeys,
};

/** 地域×形式ごとの候補キー(静的データ由来なのでプロセス内でメモ化) */
const candidatesCache = new Map<string, string[]>();

export function listCandidateKeys(
	regionId: RegionId,
	quizType: QuizType,
): string[] {
	const cacheKey = `${regionId}:${quizType}`;
	let keys = candidatesCache.get(cacheKey);
	if (!keys) {
		keys = ENUMERATORS[quizType](regionId);
		candidatesCache.set(cacheKey, keys);
	}
	return keys;
}

export function listCandidates(
	regionId: RegionId,
	quizTypes: QuizType[],
): string[] {
	return quizTypes.flatMap((t) => listCandidateKeys(regionId, t));
}

/** 形式ごとの候補問題数(設定画面で0問の形式をdisabledにするのに使う) */
export function candidateCountsByType(
	regionId: RegionId,
): Record<QuizType, number> {
	return Object.fromEntries(
		QUIZ_TYPE_IDS.map((t) => [t, listCandidateKeys(regionId, t).length]),
	) as Record<QuizType, number>;
}

// 進捗の分母に数える形式 = 「設問の主語がそのAOP」の形式のみ。AOPが4択の正解に
// すぎない回答側形式(odd-one-out/variety/location)は、そのAOP自身について問う設問
// ではないため進捗(そのAOPをどれだけ学んだか)の母数から除外する。
const SUBJECT_QUIZ_TYPES: QuizType[] = QUIZ_TYPE_IDS.filter(
	(t) => !AOP_ANSWER_QUIZ_TYPES.has(t),
);

/**
 * 地域ごとの「AOP slug -> そのAOPが主語の候補問題数」(進捗の分母)。
 * 回答側形式(odd-one-out/variety/location)は除外する。静的データ由来なのでメモ化。
 */
const candidateCountsByAopIdCache = new Map<RegionId, Map<string, number>>();

export function candidateCountsByAopId(
	regionId: RegionId,
): Map<string, number> {
	let counts = candidateCountsByAopIdCache.get(regionId);
	if (!counts) {
		counts = new Map<string, number>();
		for (const key of listCandidates(regionId, SUBJECT_QUIZ_TYPES)) {
			const parsed = parseKey(key);
			if (!parsed) continue;
			counts.set(parsed.aopId, (counts.get(parsed.aopId) ?? 0) + 1);
		}
		candidateCountsByAopIdCache.set(regionId, counts);
	}
	return counts;
}

/** キー文字列から1問を具現化。不正・失効キーは null */
export function materializeQuestion(
	key: string,
	rng: Rng,
): QuizQuestion | null {
	const parsed = parseKey(key);
	if (!parsed) return null;
	switch (parsed.quizType) {
		case "colors":
			return materializeColorsQuestion(parsed, rng);
		case "aop-variety":
			return materializeAopVarietyQuestion(parsed, rng);
		case "aop-subregion":
			return materializeAopSubregionQuestion(parsed, rng);
		case "aop-classification":
			return materializeAopClassificationQuestion(parsed, rng);
		case "grand-cru-select":
			return materializeGrandCruSelectQuestion(parsed, rng);
		case "grand-cru-odd":
			return materializeGrandCruOddQuestion(parsed, rng);
		case "odd-one-out":
			return materializeOddOneOutQuestion(parsed, rng);
		case "variety":
			return materializeVarietyQuestion(parsed, rng);
		case "location":
			return materializeLocationQuestion(parsed, rng);
	}
}

/** 地域ごとの列挙済みキー集合(recordAnswer の不正キー検証用) */
const keySetCache = new Map<RegionId, Set<string>>();

export interface QuestionKeyInfo {
	quizType: QuizType;
	regionId: RegionId;
}

/**
 * キーが実際に列挙される問題であることを検証し、形式と地域を導出する。
 * クライアント申告の quizType/regionId を信用しないために使う。
 */
export function getQuestionKeyInfo(key: string): QuestionKeyInfo | null {
	const parsed = parseKey(key);
	if (!parsed) return null;
	const subject = getAop(parsed.aopId);
	if (!subject) return null;
	const regionId = subject.region;
	let keySet = keySetCache.get(regionId);
	if (!keySet) {
		keySet = new Set(listCandidates(regionId, [...QUIZ_TYPE_IDS]));
		keySetCache.set(regionId, keySet);
	}
	if (!keySet.has(key)) return null;
	return { quizType: parsed.quizType, regionId };
}
