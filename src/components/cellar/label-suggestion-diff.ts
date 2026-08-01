import type { LabelSuggestions } from "#/lib/ai/label-extraction";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";

// エチケット解析の結果と現在のフォーム値を突き合わせ、差分のある項目だけを
// ユーザに選ばせるためのビュー用データを組み立てる(#362)。
// TODO: 実装中
export interface LabelDiffItem {
	key: "name" | "producer" | "vintage" | "region" | "grapeVarietyIds";
	label: string;
	current: string;
	suggested: string;
	patch: Partial<DrunkWineFieldsValue>;
}

export function buildLabelDiffs(
	_values: DrunkWineFieldsValue,
	_suggestions: LabelSuggestions,
): LabelDiffItem[] {
	throw new Error("not implemented");
}
