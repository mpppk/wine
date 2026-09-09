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
	{
		id: "spain",
		nameJa: "スペイン",
		nameLocal: "España",
		countryNameEn: "Spain",
	},
] as const satisfies readonly WineCountry[];

export function getCountry(countryId: string): WineCountry | undefined {
	return WINE_COUNTRIES.find((c) => c.id === countryId);
}

/** 国ごとの地域グループ。/regions の国別セクション表示のSSOT。 */
export interface RegionsByCountry<TRegion extends Pick<Region, "country">> {
	country: WineCountry;
	regions: TRegion[];
}

/**
 * 地域一覧を国ごとにまとめる(#586)。
 * - 国の並び順は WINE_COUNTRIES の定義順(国マスタがSSOT)
 * - 国内の地域順は入力順(REGIONS定義順)を保つ(決定的)
 * - WINE_COUNTRIES に突合できない地域があっても落とさず、countryJa等から
 *   合成した国グループに末尾へまとめる(沈黙の欠落を避ける)
 */
export function groupRegionsByCountry<
	TRegion extends Pick<Region, "country" | "countryJa" | "nameLocal">,
>(regions: readonly TRegion[]): RegionsByCountry<TRegion>[] {
	const groups = new Map<string, RegionsByCountry<TRegion>>();
	for (const country of WINE_COUNTRIES) {
		groups.set(country.id, { country, regions: [] });
	}
	for (const region of regions) {
		const country = countryForRegion(region);
		if (country) {
			groups.get(country.id)?.regions.push(region);
			continue;
		}
		const fallbackId = `other:${region.country}`;
		let fallback = groups.get(fallbackId);
		if (!fallback) {
			fallback = {
				country: {
					id: fallbackId,
					nameJa: region.countryJa,
					nameLocal: region.country,
					countryNameEn: region.country,
				},
				regions: [],
			};
			groups.set(fallbackId, fallback);
		}
		fallback.regions.push(region);
	}
	return [...groups.values()].filter((g) => g.regions.length > 0);
}

/** 地域の所属国を引く。REGIONS の country は英語名なので countryNameEn で突合する。 */
export function countryForRegion(
	region: Pick<Region, "country">,
): WineCountry | undefined {
	return WINE_COUNTRIES.find((c) => c.countryNameEn === region.country);
}
