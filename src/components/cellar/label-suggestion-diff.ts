import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import { type ProvenanceValue, provenanceNameJa } from "#/lib/wine/provenance";
import { getVariety } from "#/lib/wine/service";

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

/**
 * 産地の表示名。表示は `provenanceNameJa`(産地ピッカー・一覧と同じ SSOT)に委ね、
 * マスタに無いIDだけ素のIDへ退避する——「値は入っているのに(未入力)と出る」より
 * 生のIDが見えるほうが、差分を承認するかの判断材料になる。
 */
function provenanceDisplay(value: ProvenanceValue): string {
	const id = value.aopId ?? value.regionId ?? value.countryId;
	if (!id) return EMPTY_DISPLAY;
	return provenanceNameJa(value) ?? id;
}

/**
 * 候補の産地を「最も細かい1つだけ」へ畳む(AOP > 地域 > 国。#374 の粒度の優先順)。
 *
 * `buildLabelSuggestions` は AOP を解決できたとき **その地域も併せて返す**ため、
 * 候補は aopId と regionId を同時に持ちうる。一方フォーム側
 * (`DrunkWineFormState`)の産地は3つのうち高々1つなので、ここで1つに絞る。
 */
function suggestedProvenance(s: LabelSuggestions): ProvenanceValue | undefined {
	if (s.aopId) return { aopId: s.aopId };
	if (s.regionId) return { regionId: s.regionId };
	if (s.countryId) return { countryId: s.countryId };
	return undefined;
}

function sameIds(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((id, i) => id === sortedB[i]);
}

export interface LabelDiffItem {
	key: "name" | "producer" | "vintage" | "provenance" | "grapeVarietyIds";
	label: string;
	/** 表示用。未入力は EMPTY_DISPLAY 文字列 */
	current: string;
	suggested: string;
	patch: Partial<DrunkWineFieldsValue>;
}

/**
 * 解析結果(候補)と現在のフォーム値を比較し、値が変わる項目だけを返す。
 *
 * 産地は粒度(国 / 地域 / AOP)が違っても**1項目**として扱う。3つは排他で
 * 「最も細かい1つだけ」を持つ不変条件(#374)があり、粒度ごとに選べると
 * 「AOPは反映するが国は元のまま」のような不整合な状態を作れてしまうため。
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

	const suggestedPlace = suggestedProvenance(s);
	if (suggestedPlace) {
		const current: ProvenanceValue = {
			aopId: values.aopId,
			regionId: values.regionId,
			countryId: values.countryId,
		};
		// 3キーすべてを比べる。粒度が変わるだけの差分(国→AOP 等)も検出したいので、
		// 「候補が持つキー」だけを見ると取りこぼす。
		const changed =
			suggestedPlace.aopId !== current.aopId ||
			suggestedPlace.regionId !== current.regionId ||
			suggestedPlace.countryId !== current.countryId;
		if (changed) {
			diffs.push({
				key: "provenance",
				label: "産地",
				current: provenanceDisplay(current),
				suggested: provenanceDisplay(suggestedPlace),
				// **3キーすべてを明示的に入れる**(ProvenancePicker の onChange と同じ形)。
				// DrunkWineForm の update は `{...prev, ...patch}` なので、undefined を
				// 明示したキーだけが既存値を消す。候補が持つキーだけを patch に入れると、
				// 例えば「国=フランスが入っている状態でAOP候補を反映」したときに
				// countryId が残り、排他の不変条件が壊れる。
				patch: {
					aopId: suggestedPlace.aopId,
					regionId: suggestedPlace.regionId,
					countryId: suggestedPlace.countryId,
				},
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
