import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import { getAop, getRegion, getVariety } from "#/lib/wine/service";

// エチケット解析の結果と現在のフォーム値を突き合わせ、差分のある項目だけを
// ユーザに選ばせるためのビュー用データを組み立てる(#362)。
// 「未入力の項目にしか反映しない」だと再解析(写真追加・エンジン切替)の結果が
// 一切反映されずクレジットだけ消費されるため、上書き事故を防ぐ性質は維持したまま
// (自動反映ではなくユーザの選択制にする)、値が変わる項目は既存値の有無を問わず
// 提示する。

const EMPTY_DISPLAY = "(未入力)";

function grapeNamesDisplay(ids: string[]): string {
	if (ids.length === 0) return EMPTY_DISPLAY;
	return ids.map((id) => getVariety(id)?.nameJa ?? id).join("、");
}

function regionAopDisplay(
	regionId: string | undefined,
	aopId: string | undefined,
): string {
	const parts: string[] = [];
	if (regionId) parts.push(getRegion(regionId)?.nameJa ?? regionId);
	if (aopId) parts.push(getAop(aopId)?.nameJa ?? aopId);
	return parts.length > 0 ? parts.join(" / ") : EMPTY_DISPLAY;
}

function sameIds(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((id, i) => id === sortedB[i]);
}

export interface LabelDiffItem {
	key: "name" | "producer" | "vintage" | "region" | "grapeVarietyIds";
	label: string;
	/** 表示用。未入力は EMPTY_DISPLAY 文字列 */
	current: string;
	suggested: string;
	patch: Partial<DrunkWineFieldsValue>;
}

/**
 * 解析結果(候補)と現在のフォーム値を比較し、値が変わる項目だけを返す。
 * 地域とAOPは常に1項目にまとめる(buildLabelSuggestions は AOP が解決できた
 * ときに必ずその地域も併せて返すため、片方だけ選べると絞り込みと矛盾した
 * 状態になりうる)。
 */
export function buildLabelDiffs(
	values: DrunkWineFieldsValue,
	s: LabelSuggestions,
): LabelDiffItem[] {
	const diffs: LabelDiffItem[] = [];

	if (s.name && s.name !== values.name.trim()) {
		diffs.push({
			key: "name",
			label: "名前",
			current: values.name.trim() || EMPTY_DISPLAY,
			suggested: s.name,
			patch: { name: s.name },
		});
	}

	if (s.producer && s.producer !== values.producer.trim()) {
		diffs.push({
			key: "producer",
			label: "生産者",
			current: values.producer.trim() || EMPTY_DISPLAY,
			suggested: s.producer,
			patch: { producer: s.producer },
		});
	}

	if (s.vintage != null && String(s.vintage) !== values.vintage) {
		diffs.push({
			key: "vintage",
			label: "ヴィンテージ",
			current: values.vintage || EMPTY_DISPLAY,
			suggested: String(s.vintage),
			patch: { vintage: String(s.vintage) },
		});
	}

	if (s.regionId || s.aopId) {
		const regionChanged = !!s.regionId && s.regionId !== values.regionId;
		const aopChanged = !!s.aopId && s.aopId !== values.aopId;
		if (regionChanged || aopChanged) {
			const patch: Partial<DrunkWineFieldsValue> = {};
			if (s.regionId) patch.regionId = s.regionId;
			if (s.aopId) patch.aopId = s.aopId;
			diffs.push({
				key: "region",
				label: "地域/AOP",
				current: regionAopDisplay(values.regionId, values.aopId),
				suggested: regionAopDisplay(
					s.regionId ?? values.regionId,
					s.aopId ?? values.aopId,
				),
				patch,
			});
		}
	}

	if (
		s.grapeVarietyIds?.length &&
		!sameIds(s.grapeVarietyIds, values.grapeVarietyIds)
	) {
		diffs.push({
			key: "grapeVarietyIds",
			label: "ぶどう品種",
			current: grapeNamesDisplay(values.grapeVarietyIds),
			suggested: grapeNamesDisplay(s.grapeVarietyIds),
			patch: { grapeVarietyIds: s.grapeVarietyIds },
		});
	}

	return diffs;
}
