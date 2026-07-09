import type { ExpressionSpecification } from "maplibre-gl";
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

// ── 進捗(クイズ学習済み率)の色分けモード ───────────────────────────────
// GitHubのコントリビューショングラフ風の逐次(sequential)緑ランプ。学習済み率が
// 高いAOPほど濃い緑で塗る。データなし(未出題)は淡いグレーで沈める。
// dataviz スキルの validate_palette を ordinal モード(surface #f2f0ec)で検証済み:
// fill/line とも 単一色相・明→暗の単調・隣接ΔL>=0.06・淡端>=2:1 を全PASS。

/** 未出題(データなし)AOPの色。中立的なグレーで沈める */
export const PROGRESS_EMPTY_COLOR = { fill: "#d4d2cc", line: "#b4b1aa" };

/** 学習済み率のバケット(昇順=薄→濃)。fill と同色相のより濃い line を対に持つ */
export const PROGRESS_BUCKETS: { fill: string; line: string }[] = [
	{ fill: "#5cbb78", line: "#3f9e5c" },
	{ fill: "#3a9e59", line: "#2a7d43" },
	{ fill: "#237d40", line: "#175c2c" },
	{ fill: "#14532b", line: "#0c3d1f" },
];

// バケット境界(4段階なら 0.25/0.5/0.75)。等間隔に自動生成する
const PROGRESS_STOPS = PROGRESS_BUCKETS.map(
	(_, i) => i / PROGRESS_BUCKETS.length,
);

// feature-state.progress(0〜1)を step で色に写す式を組む。未設定は coalesce で
// -1 に落ち、最初の stop(0)より小さいので empty 色になる。
function buildProgressStepExpr(
	pick: (bucket: { fill: string; line: string }) => string,
	empty: string,
): ExpressionSpecification {
	// step: [input, output0(<stop1), stop1, output1, stop2, output2, ...]
	const args: (number | string)[] = [empty];
	for (let i = 0; i < PROGRESS_BUCKETS.length; i++) {
		args.push(PROGRESS_STOPS[i], pick(PROGRESS_BUCKETS[i]));
	}
	return [
		"step",
		["coalesce", ["feature-state", "progress"], -1],
		...args,
	] as unknown as ExpressionSpecification;
}

export function progressFillColorExpr(): ExpressionSpecification {
	return buildProgressStepExpr((b) => b.fill, PROGRESS_EMPTY_COLOR.fill);
}

export function progressLineColorExpr(): ExpressionSpecification {
	return buildProgressStepExpr((b) => b.line, PROGRESS_EMPTY_COLOR.line);
}

// 区分(kind)モードの色式。初期ロードとモード切替の双方から使えるよう関数化する。
// 特級(grand-cru)タグ持ちは区分に関わらず最濃色で塗るオーバーライドを維持。
export function kindFillColorExpr(): ExpressionSpecification {
	return [
		"case",
		["in", "grand-cru", ["coalesce", ["get", "tags"], ["literal", []]]],
		GRAND_CRU_TAG_COLOR.fill,
		[
			"match",
			["get", "kind"],
			"regional",
			KIND_COLORS.regional.fill,
			"village",
			KIND_COLORS.village.fill,
			"vineyard",
			KIND_COLORS.vineyard.fill,
			"winery",
			KIND_COLORS.winery.fill,
			KIND_COLORS.village.fill,
		],
	] as unknown as ExpressionSpecification;
}

export function kindLineColorExpr(): ExpressionSpecification {
	return [
		"case",
		["in", "grand-cru", ["coalesce", ["get", "tags"], ["literal", []]]],
		GRAND_CRU_TAG_COLOR.line,
		[
			"match",
			["get", "kind"],
			"regional",
			KIND_COLORS.regional.line,
			"village",
			KIND_COLORS.village.line,
			"vineyard",
			KIND_COLORS.vineyard.line,
			"winery",
			KIND_COLORS.winery.line,
			KIND_COLORS.village.line,
		],
	] as unknown as ExpressionSpecification;
}
