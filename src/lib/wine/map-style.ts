import type { AopKind } from "./types";

// データ可視化向けの淡色ベースマップ(ラベル・道路が控えめでポリゴンが主役になる)。
// APIキー不要・利用制限なしの OpenFreeMap を利用する。
export const BASEMAP_STYLE_URL =
	"https://tiles.openfreemap.org/styles/positron";

// AOP区分の順序ランプ(単一色相・明→暗)。dataviz スキルの validate_palette で
// ordinal モード全チェックPASS済み(surface #f2f0ec)。
// winery はデータ投入時(ボルドー対応時)に validate_palette で再検証すること。
export const KIND_COLORS: Record<AopKind, { fill: string; line: string }> = {
	regional: { fill: "#D98B84", line: "#B06A63" },
	village: { fill: "#B84A44", line: "#933B36" },
	vineyard: { fill: "#8C2332", line: "#6E1B27" },
	winery: { fill: "#5E1621", line: "#470F18" },
};

/**
 * 特級(grand-cru)タグ持ちのAOPは区分に関わらず最も濃い色で塗る。
 * シャンパーニュの特級村(kind=village)が村名色に埋もれないようにするための
 * オーバーライドで、旧グラン・クリュ区分の見た目を維持する。
 */
export const GRAND_CRU_TAG_COLOR = KIND_COLORS.vineyard;

export const KIND_LABELS_JA: Record<AopKind, string> = {
	regional: "地方名",
	village: "村名",
	vineyard: "畑名",
	winery: "ワイナリー",
};

/** 重なり順(小さい=下)。広域AOCの上に村名、その上に畑を描く */
export const KIND_RANK: Record<AopKind, number> = {
	regional: 0,
	village: 1,
	vineyard: 2,
	winery: 3,
};

export const AOP_KINDS: AopKind[] = [
	"regional",
	"village",
	"vineyard",
	"winery",
];
