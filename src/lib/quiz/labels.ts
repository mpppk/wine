import { COLOR_LABELS_JA } from "#/lib/wine/terminology";
import type { Aop, WineColor } from "#/lib/wine/types";
import { GRAPE_VARIETY_IDS, getVariety } from "#/lib/wine/varieties";

// クイズの設問・選択肢・解説で使う日本語ラベル。
// 色ラベル(COLOR_LABELS_JA)はドメイン語彙として terminology に集約し、後方互換の
// ため再エクスポートする(地図の詳細パネルと表記を共有する。#42)。
export { COLOR_LABELS_JA };

/** 色の正規順(選択肢ラベルとコンボIDの並びを安定させる) */
export const COLOR_ORDER: WineColor[] = [
	"red",
	"white",
	"sweet-white",
	"rose",
	"sparkling",
];

/** 「〜ワインの生産が…」のような文中で使う呼称 */
export const COLOR_WINE_LABELS_JA: Record<WineColor, string> = {
	red: "赤ワイン",
	white: "白ワイン",
	"sweet-white": "甘口白ワイン",
	rose: "ロゼワイン",
	sparkling: "スパークリングワイン",
};

/** 色の組み合わせを正規順に並べる */
export function sortColors(colors: readonly WineColor[]): WineColor[] {
	return COLOR_ORDER.filter((c) => colors.includes(c));
}

/** 色コンボの選択肢ID(例: "red+white")。正規順なので同一コンボは同一ID */
export function colorComboId(colors: readonly WineColor[]): string {
	return sortColors(colors).join("+");
}

/** 色コンボの表示(例: "赤・白"、単色は "赤のみ") */
export function formatColorsJa(colors: readonly WineColor[]): string {
	const sorted = sortColors(colors);
	const only = sorted[0];
	if (sorted.length === 1 && only !== undefined) {
		return `${COLOR_LABELS_JA[only]}のみ`;
	}
	return sorted.map((c) => COLOR_LABELS_JA[c]).join("・");
}

/** AOPの選択肢表示名(日本語名 + 原語名の補助表示) */
export function aopOptionLabel(aop: Aop): { label: string; labelSub: string } {
	return { label: aop.nameJa, labelSub: aop.shortName };
}

/** 主要品種(principal)のIDを varieties の定義順に正規化した配列 */
export function principalVarietyIds(aop: Aop): string[] {
	const ids = aop.grapes
		.filter((g) => g.role === "principal")
		.map((g) => g.varietyId);
	return GRAPE_VARIETY_IDS.filter((id) => ids.includes(id));
}

/** 主要品種コンボの選択肢ID(例: "chardonnay"、"cabernet-sauvignon+merlot")。正規順なので同一コンボは同一ID */
export function principalComboId(aop: Aop): string {
	return principalVarietyIds(aop).join("+");
}

/** 主要品種コンボの表示(例: "シャルドネ"、"カベルネ・ソーヴィニヨン・メルロ") */
export function formatPrincipalGrapesJa(comboId: string): string {
	return comboId
		.split("+")
		.map((id) => getVariety(id)?.nameJa ?? id)
		.join("・");
}
