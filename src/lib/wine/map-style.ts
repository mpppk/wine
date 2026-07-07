import type { Classification } from "./types";

// データ可視化向けの淡色ベースマップ(ラベル・道路が控えめでポリゴンが主役になる)。
// APIキー不要・利用制限なしの OpenFreeMap を利用する。
export const BASEMAP_STYLE_URL =
	"https://tiles.openfreemap.org/styles/positron";

// AOC格付けの順序ランプ(単一色相・明→暗)。dataviz スキルの validate_palette で
// ordinal モード全チェックPASS済み(surface #f2f0ec)。
export const CLASSIFICATION_COLORS: Record<
	Classification,
	{ fill: string; line: string }
> = {
	regional: { fill: "#D98B84", line: "#B06A63" },
	village: { fill: "#B84A44", line: "#933B36" },
	"grand-cru": { fill: "#8C2332", line: "#6E1B27" },
};

export const CLASSIFICATION_LABELS_JA: Record<Classification, string> = {
	regional: "地方名",
	village: "村名",
	"grand-cru": "グラン・クリュ",
};

/** 重なり順(小さい=下)。広域AOCの上に村名、その上にグラン・クリュを描く */
export const CLASSIFICATION_RANK: Record<Classification, number> = {
	regional: 0,
	village: 1,
	"grand-cru": 2,
};

export const CLASSIFICATIONS: Classification[] = [
	"regional",
	"village",
	"grand-cru",
];
