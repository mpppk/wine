import type { QuizType } from "./types";

// 問題キー = 「テストされる事実」を表す安定文字列。区切りは ":"
// (slug/品種ID/サブリージョンID等は [a-z0-9-] なので衝突しない)。
// 末尾セグメントは常に subject(正解)AOP の slug。
// ディストラクタや選択肢順はレンダリングごとに変わってよく、成績はキー単位で集計する。
//
//   colors:{aopId}
//   aop-variety:{aopId}          設問文の主語がそのAOP。正解=主要品種コンボ
//   aop-subregion:{aopId}        設問文の主語がそのAOP。正解=所属地区
//   aop-classification:{aopId}   設問文の主語がそのAOP。正解=格付けラベル
//   grand-cru-select:{aopId}     正解=その地区の特級。地区は subject の subregionId から導出
//   grand-cru-odd:{aopId}        正解=その地区の非特級(一級)。他3つは同地区の特級
//   odd-one-out:{axis}:{axisValue}:{aopId}   axis = color | grape | subregion | tag
//   variety:{varietyId}:{aopId}
//   location:{direction}:{subregionId}:{aopId}   direction = north | south | east | west

export const ODD_ONE_OUT_AXES = ["color", "grape", "subregion", "tag"] as const;
export type OddOneOutAxis = (typeof ODD_ONE_OUT_AXES)[number];

export const LOCATION_DIRECTIONS = ["north", "south", "east", "west"] as const;
export type LocationDirection = (typeof LOCATION_DIRECTIONS)[number];

export type ParsedQuestionKey =
	| { quizType: "colors"; aopId: string }
	| { quizType: "aop-variety"; aopId: string }
	| { quizType: "aop-subregion"; aopId: string }
	| { quizType: "aop-classification"; aopId: string }
	| { quizType: "grand-cru-select"; aopId: string }
	| { quizType: "grand-cru-odd"; aopId: string }
	| {
			quizType: "odd-one-out";
			axis: OddOneOutAxis;
			axisValue: string;
			aopId: string;
	  }
	| { quizType: "variety"; varietyId: string; aopId: string }
	| {
			quizType: "location";
			direction: LocationDirection;
			subregionId: string;
			aopId: string;
	  };

const SEGMENT_PATTERN = /^[a-z0-9-]+$/;

export function buildColorsKey(aopId: string): string {
	return `colors:${aopId}`;
}

export function buildAopVarietyKey(aopId: string): string {
	return `aop-variety:${aopId}`;
}

export function buildAopSubregionKey(aopId: string): string {
	return `aop-subregion:${aopId}`;
}

export function buildAopClassificationKey(aopId: string): string {
	return `aop-classification:${aopId}`;
}

export function buildGrandCruSelectKey(aopId: string): string {
	return `grand-cru-select:${aopId}`;
}

export function buildGrandCruOddKey(aopId: string): string {
	return `grand-cru-odd:${aopId}`;
}

export function buildOddOneOutKey(
	axis: OddOneOutAxis,
	axisValue: string,
	aopId: string,
): string {
	return `odd-one-out:${axis}:${axisValue}:${aopId}`;
}

export function buildVarietyKey(varietyId: string, aopId: string): string {
	return `variety:${varietyId}:${aopId}`;
}

export function buildLocationKey(
	direction: LocationDirection,
	subregionId: string,
	aopId: string,
): string {
	return `location:${direction}:${subregionId}:${aopId}`;
}

/** 形式不正なら null(存在チェックはしない。それは generators 側の責務) */
export function parseKey(key: string): ParsedQuestionKey | null {
	const segments = key.split(":");
	if (segments.some((s) => !SEGMENT_PATTERN.test(s))) return null;
	const [head, ...rest] = segments;
	switch (head as QuizType) {
		case "colors": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "colors", aopId };
		}
		case "aop-variety": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "aop-variety", aopId };
		}
		case "aop-subregion": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "aop-subregion", aopId };
		}
		case "aop-classification": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "aop-classification", aopId };
		}
		case "grand-cru-select": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "grand-cru-select", aopId };
		}
		case "grand-cru-odd": {
			const [aopId] = rest;
			if (rest.length !== 1 || aopId === undefined) return null;
			return { quizType: "grand-cru-odd", aopId };
		}
		case "odd-one-out": {
			const [axis, axisValue, aopId] = rest;
			if (
				rest.length !== 3 ||
				axis === undefined ||
				axisValue === undefined ||
				aopId === undefined
			) {
				return null;
			}
			if (!ODD_ONE_OUT_AXES.includes(axis as OddOneOutAxis)) return null;
			return {
				quizType: "odd-one-out",
				axis: axis as OddOneOutAxis,
				axisValue,
				aopId,
			};
		}
		case "variety": {
			const [varietyId, aopId] = rest;
			if (rest.length !== 2 || varietyId === undefined || aopId === undefined) {
				return null;
			}
			return { quizType: "variety", varietyId, aopId };
		}
		case "location": {
			const [direction, subregionId, aopId] = rest;
			if (
				rest.length !== 3 ||
				direction === undefined ||
				subregionId === undefined ||
				aopId === undefined
			) {
				return null;
			}
			if (!LOCATION_DIRECTIONS.includes(direction as LocationDirection)) {
				return null;
			}
			return {
				quizType: "location",
				direction: direction as LocationDirection,
				subregionId,
				aopId,
			};
		}
		default:
			return null;
	}
}
