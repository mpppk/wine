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
 * 詳細パネル等に出す、境界データの出典・粒度の注記。
 * フランスはINAO(区画/コミューン)、イタリアはEU PDOデータセット(コミューン単位)。
 */
export function getBoundarySourceNoteJa(aop: Aop): string {
	const region = getRegion(aop.region);
	if (region?.country === "Italy") {
		return "地図はEU PDO境界データ(コミューン単位, Candiago et al. 2022)を簡略化して表示しています。";
	}
	return aop.kind === "regional"
		? "地図はコミューン(市町村)単位の生産地域を表示しています。"
		: "地図はINAOの区画データを簡略化して表示しています。";
}
