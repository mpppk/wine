import type { Region } from "./types";

// 国マスタ。マイセラーの粗い産地紐付け(drunk_wine.country_id)と産地ピッカーの
// 最上位階層が参照する。地域(regions.ts)の Region.country("France" 等の英語名)と
// countryNameEn で突合して地域→国を導出する。国を足すときは REGIONS 側の country と
// 綴りを一致させること(突合できない地域が無いことは countries.test.ts が固定する)。

export interface WineCountry {
	/** URLセーフなスラッグ。drunk_wine.country_id が参照する公開キー */
	id: string;
	nameJa: string;
	/** 現地語表記 */
	nameLocal: string;
	/** Region.country と突合する英語名 */
	countryNameEn: string;
}

export const WINE_COUNTRIES = [
	{
		id: "france",
		nameJa: "フランス",
		nameLocal: "France",
		countryNameEn: "France",
	},
	{
		id: "italy",
		nameJa: "イタリア",
		nameLocal: "Italia",
		countryNameEn: "Italy",
	},
] as const satisfies readonly WineCountry[];

export function getCountry(countryId: string): WineCountry | undefined {
	return WINE_COUNTRIES.find((c) => c.id === countryId);
}

/** 地域の所属国を引く。REGIONS の country は英語名なので countryNameEn で突合する。 */
export function countryForRegion(
	region: Pick<Region, "country">,
): WineCountry | undefined {
	return WINE_COUNTRIES.find((c) => c.countryNameEn === region.country);
}
