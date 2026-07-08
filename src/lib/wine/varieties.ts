import type { GrapeVariety } from "./types";

// 対応地域(ブルゴーニュ/ボジョレー/シャンパーニュ/アルザス)のAOCで許可されている品種の正規化マスタ。
// aops.generated.ts の grapes.varietyId はこの id を参照する。
export const GRAPE_VARIETIES: GrapeVariety[] = [
	{
		id: "pinot-noir",
		nameJa: "ピノ・ノワール",
		nameFr: "Pinot noir",
		color: "red",
	},
	{ id: "gamay", nameJa: "ガメイ", nameFr: "Gamay", color: "red" },
	{ id: "cesar", nameJa: "セザール", nameFr: "César", color: "red" },
	{ id: "tressot", nameJa: "トレソ", nameFr: "Tressot", color: "red" },
	{
		id: "chardonnay",
		nameJa: "シャルドネ",
		nameFr: "Chardonnay",
		color: "white",
	},
	{ id: "aligote", nameJa: "アリゴテ", nameFr: "Aligoté", color: "white" },
	{
		id: "sauvignon-blanc",
		nameJa: "ソーヴィニヨン・ブラン",
		nameFr: "Sauvignon blanc",
		color: "white",
	},
	{
		id: "sauvignon-gris",
		nameJa: "ソーヴィニヨン・グリ",
		nameFr: "Sauvignon gris",
		color: "white",
	},
	{
		id: "pinot-blanc",
		nameJa: "ピノ・ブラン",
		nameFr: "Pinot blanc",
		color: "white",
	},
	{
		id: "pinot-gris",
		nameJa: "ピノ・グリ",
		nameFr: "Pinot gris",
		color: "white",
	},
	{ id: "melon", nameJa: "ムロン", nameFr: "Melon", color: "white" },
	{ id: "sacy", nameJa: "サシー", nameFr: "Sacy", color: "white" },
	{ id: "meunier", nameJa: "ムニエ", nameFr: "Meunier", color: "red" },
	{ id: "arbane", nameJa: "アルバンヌ", nameFr: "Arbane", color: "white" },
	{
		id: "petit-meslier",
		nameJa: "プティ・メリエ",
		nameFr: "Petit Meslier",
		color: "white",
	},
	{
		id: "riesling",
		nameJa: "リースリング",
		nameFr: "Riesling",
		color: "white",
	},
	{
		id: "gewurztraminer",
		nameJa: "ゲヴュルツトラミネール",
		nameFr: "Gewurztraminer",
		color: "white",
	},
	{
		id: "sylvaner",
		nameJa: "シルヴァネール",
		nameFr: "Sylvaner",
		color: "white",
	},
	{
		id: "muscat-blanc-a-petits-grains",
		nameJa: "ミュスカ・ブラン・ア・プティ・グラン",
		nameFr: "Muscat blanc à petits grains",
		color: "white",
	},
	{
		id: "muscat-rose-a-petits-grains",
		nameJa: "ミュスカ・ローズ・ア・プティ・グラン",
		nameFr: "Muscat rosé à petits grains",
		color: "white",
	},
	{
		id: "muscat-ottonel",
		nameJa: "ミュスカ・オットネル",
		nameFr: "Muscat Ottonel",
		color: "white",
	},
	{
		id: "auxerrois",
		nameJa: "オーセロワ",
		nameFr: "Auxerrois",
		color: "white",
	},
	{
		id: "chasselas",
		nameJa: "シャスラ",
		nameFr: "Chasselas",
		color: "white",
	},
	{
		id: "savagnin-rose",
		nameJa: "サヴァニャン・ローズ(クレヴネール)",
		nameFr: "Savagnin rose",
		color: "white",
	},
];

export const GRAPE_VARIETY_IDS = GRAPE_VARIETIES.map((v) => v.id);

export function getVariety(id: string): GrapeVariety | undefined {
	return GRAPE_VARIETIES.find((v) => v.id === id);
}
