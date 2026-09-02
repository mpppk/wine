import { AOPS } from "./aops-data";
import { KIND_LABELS_JA } from "./map-style";
import { getRegion } from "./regions";
import type { Aop, AopKind, WineColor } from "./types";

// ワイン色の日本語表記。地図の詳細パネル(AopDetailPanel)とクイズ(lib/quiz/labels)の
// 両方で使うドメイン語彙の単一情報源。表記変更(例「泡」→「スパークリング」)を
// 片方だけ直して食い違うのを防ぐため、ここに集約する。
export const COLOR_LABELS_JA: Record<WineColor, string> = {
	red: "赤",
	white: "白",
	"sweet-white": "甘口白",
	rose: "ロゼ",
	sparkling: "泡",
};

// 地域の国(Region.country)に応じてUI表記を切り替えるヘルパー。
// フランスは「AOP/AOC」、イタリアは「DOC/DOCG」、スペインは「DO/DOCa」と、
// 原産地呼称制度の呼び名が異なるため、地域スコープの画面ではこの関数を通して
// 総称を出す。アプリ名など国に依らないグローバルな見出しは従来どおり "AOP" のまま。

/**
 * 境界データをEU PDOデータセット(Candiago et al. 2022)から生成している国。
 * フランス(INAO)以外の収録国はこのデータセットに依存しており、出典注記も
 * 生成スクリプト(scripts/build-eu-geodata.mjs)もこの集合で分岐する。
 */
const EU_PDO_COUNTRIES = new Set(["Italy", "Spain"]);

/**
 * 地域IDに対応する原産地呼称の総称(日本語UI用)。
 *
 * 「N DOC/DOCG」のように収録件数と並べて出すため、IGT を収録している州では
 * IGT も総称に含める(でないと IGT の1件を DOC/DOCG として数えることになる)。
 * IGT を持たない州(ピエモンテ)では逆に含めない。#212
 */
export function getAppellationTermJa(regionId: string): string {
	const region = getRegion(regionId);
	if (region?.country === "Italy") {
		const hasIgt = AOPS.some(
			(a) => a.region === regionId && a.tags?.includes("igt"),
		);
		return hasIgt ? "DOC/DOCG/IGT" : "DOC/DOCG";
	}
	if (region?.country === "Spain") {
		// Vino de Pago は DO の階層の外にある独立したDOPなので、収録している州では
		// 総称にも並べる(でないとVPの件数をDOとして数えることになる。IGTと同じ理由)。
		const hasPago = AOPS.some(
			(a) => a.region === regionId && a.tags?.includes("vino-de-pago"),
		);
		return hasPago ? "DO/DOCa/VP" : "DO/DOCa";
	}
	return "AOP";
}

/**
 * 「法的に独立したアペラシオンである」ことを示すバッジ文言。制度名を国ごとに
 * 出し分ける(フランス=AOC / イタリア=DOC/DOCG)。isLegalAppellation が真の
 * AOPに付与する。見出し用の getAppellationTermJa(仏は "AOP")とは別に、
 * バッジでは通称の "AOC" を用いる。
 *
 * IGT は同じイタリアでも DOC/DOCG とは別階級の呼称なので "IGT" を出す(#212)。
 * 地域ではなくAOP単位で決まる情報なので、判定はここに閉じる(呼び出し側で
 * タグを見て出し分けない)。
 */
export function getAppellationBadgeJa(aop: Aop): string {
	if (aop.tags?.includes("igt")) return "IGT";
	// スペインのDOP階層はAOP単位で等級が決まる(DOCa/DO/VP)。イタリアのIGTと同じく
	// 判定はここに閉じ、呼び出し側でタグを見て出し分けない。
	if (aop.tags?.includes("vino-de-pago")) return "VP";
	if (aop.tags?.includes("doca")) return "DOCa";
	const region = getRegion(aop.region);
	if (region?.country === "Italy") return "DOC/DOCG";
	if (region?.country === "Spain") return "DO";
	return "AOC";
}

/**
 * 畑(vineyard 区分)階層の呼称を地域ごとに出し分ける。ブルゴーニュは「クリマ」、
 * アルザスは「リュー・ディ」、それ以外は総称の「畑名」。クリマ/リュー・ディは
 * 地域固有の呼び名で、いずれも同じ「区画レベルの畑」を指す。
 */
export function getVineyardTermJa(regionId: string): string {
	if (regionId === "bourgogne") return "クリマ";
	if (regionId === "alsace") return "リュー・ディ";
	return "畑名";
}

/**
 * AOP区分の表示名(日本語UI用)。畑(vineyard)だけは地域固有の呼称
 * (ブルゴーニュ=クリマ / アルザス=リュー・ディ / それ以外=畑名)になるため、
 * 「区分 → 表示名」の導出をここへ集約する(#258)。
 *
 * 以前は `kind === "vineyard" ? getVineyardTermJa(...) : KIND_LABELS_JA[kind]` という
 * 同じ三項式が4箇所(詳細パネル×2・地図のポップアップ・区分フィルタ)に複製されており、
 * 地域固有呼称を持つ区分が増えたときに4箇所を同時に直す必要があった。直し漏れると
 * ポップアップと詳細パネルで表記が食い違う。
 *
 * 引数を Aop ではなく (kind, regionId) にしているのは、区分フィルタのチップが
 * 「その地域に存在する区分」の一覧を扱っており、対応する Aop を持たないため。
 */
export function getAopKindLabelJa(kind: AopKind, regionId: string): string {
	return kind === "vineyard"
		? getVineyardTermJa(regionId)
		: KIND_LABELS_JA[kind];
}

/**
 * 詳細パネル等に出す、境界データの出典・粒度の注記。
 * フランスはINAO(区画/コミューン)、イタリア・スペインはEU PDOデータセット
 * (コミューン単位)。
 */
export function getBoundarySourceNoteJa(aop: Aop): string {
	const region = getRegion(aop.region);
	if (region && EU_PDO_COUNTRIES.has(region.country)) {
		return "地図はEU PDO境界データ(コミューン単位, Candiago et al. 2022)を簡略化して表示しています。";
	}
	if (aop.kind === "winery") {
		return "地図はシャトーの所在地をポイントで表示しています。";
	}
	return aop.kind === "regional"
		? "地図はコミューン(市町村)単位の生産地域を表示しています。"
		: "地図はコミューン輪郭またはINAOの区画データを表示しています。";
}
