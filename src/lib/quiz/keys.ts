import type { QuizType } from "./types";

// 問題キー = 「テストされる事実」を表す安定文字列。区切りは ":"
// (slug/品種ID/サブリージョンID等は [a-z0-9-] なので衝突しない)。
// 末尾セグメントは常に subject(正解)AOP の slug。
// ディストラクタや選択肢順はレンダリングごとに変わってよく、成績はキー単位で集計する。
//
//   colors:{aopId}
//   odd-one-out:{axis}:{axisValue}:{aopId}   axis = color | grape | subregion | tag
//   variety:{varietyId}:{aopId}
//   location:{direction}:{subregionId}:{aopId}   direction = north | south | east | west

export const ODD_ONE_OUT_AXES = ["color", "grape", "subregion", "tag"] as const;
export type OddOneOutAxis = (typeof ODD_ONE_OUT_AXES)[number];

export const LOCATION_DIRECTIONS = ["north", "south", "east", "west"] as const;
export type LocationDirection = (typeof LOCATION_DIRECTIONS)[number];

export type ParsedQuestionKey =
	| { quizType: "colors"; aopId: string }
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
			if (rest.length !== 1) return null;
			return { quizType: "colors", aopId: rest[0] };
		}
		case "odd-one-out": {
			if (rest.length !== 3) return null;
			const [axis, axisValue, aopId] = rest;
			if (!ODD_ONE_OUT_AXES.includes(axis as OddOneOutAxis)) return null;
			return {
				quizType: "odd-one-out",
				axis: axis as OddOneOutAxis,
				axisValue,
				aopId,
			};
		}
		case "variety": {
			if (rest.length !== 2) return null;
			return { quizType: "variety", varietyId: rest[0], aopId: rest[1] };
		}
		case "location": {
			if (rest.length !== 3) return null;
			const [direction, subregionId, aopId] = rest;
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
