import { getRegion } from "./regions";
import type { Aop } from "./types";

// 地域の国(Region.country)に応じてUI表記を切り替えるヘルパー。
// フランスは「AOP/AOC」、イタリアは「DOC/DOCG」と、原産地呼称制度の呼び名が
// 異なるため、地域スコープの画面ではこの関数を通して総称を出す。
// アプリ名など国に依らないグローバルな見出しは従来どおり "AOP" のまま。

/** 地域IDに対応する原産地呼称の総称(日本語UI用)。 */
export function getAppellationTermJa(regionId: string): string {
	const region = getRegion(regionId);
	if (region?.country === "Italy") return "DOC/DOCG";
	return "AOP";
}

/**
 * 「法的に独立したアペラシオンである」ことを示すバッジ文言。制度名を国ごとに
 * 出し分ける(フランス=AOC / イタリア=DOC/DOCG)。isLegalAppellation が真の
 * AOPに付与する。見出し用の getAppellationTermJa(仏は "AOP")とは別に、
 * バッジでは通称の "AOC" を用いる。
 */
export function getAppellationBadgeJa(regionId: string): string {
	const region = getRegion(regionId);
	if (region?.country === "Italy") return "DOC/DOCG";
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
 * 詳細パネル等に出す、境界データの出典・粒度の注記。
 * フランスはINAO(区画/コミューン)、イタリアはEU PDOデータセット(コミューン単位)。
 */
export function getBoundarySourceNoteJa(aop: Aop): string {
	const region = getRegion(aop.region);
	if (region?.country === "Italy") {
		return "地図はEU PDO境界データ(コミューン単位, Candiago et al. 2022)を簡略化して表示しています。";
	}
	if (aop.kind === "winery") {
		return "地図はシャトーの所在地をポイントで表示しています。";
	}
	return aop.kind === "regional"
		? "地図はコミューン(市町村)単位の生産地域を表示しています。"
		: "地図はコミューン輪郭またはINAOの区画データを表示しています。";
}
