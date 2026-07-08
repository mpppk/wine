import type { Aop, WineColor } from "#/lib/wine/types";

// クイズの設問・選択肢・解説で使う日本語ラベル。

/** 色の正規順(選択肢ラベルとコンボIDの並びを安定させる) */
export const COLOR_ORDER: WineColor[] = ["red", "white", "rose", "sparkling"];

export const COLOR_LABELS_JA: Record<WineColor, string> = {
	red: "赤",
	white: "白",
	rose: "ロゼ",
	sparkling: "泡",
};

/** 「〜ワインの生産が…」のような文中で使う呼称 */
export const COLOR_WINE_LABELS_JA: Record<WineColor, string> = {
	red: "赤ワイン",
	white: "白ワイン",
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
	if (sorted.length === 1) return `${COLOR_LABELS_JA[sorted[0]]}のみ`;
	return sorted.map((c) => COLOR_LABELS_JA[c]).join("・");
}

/** AOPの選択肢表示名(日本語名 + 原語名の補助表示) */
export function aopOptionLabel(aop: Aop): { label: string; labelSub: string } {
	return { label: aop.nameJa, labelSub: aop.shortName };
}
