import type { GrapeVariety } from "./types";

// 対応地域のAOC/DOCで許可されている品種の正規化マスタ。
// aops.json の grapes.varietyId はこの id を参照する(aop-schema.ts が z.enum 化)。
export const GRAPE_VARIETIES: GrapeVariety[] = [
	{
		id: "pinot-noir",
		nameJa: "ピノ・ノワール",
		nameLocal: "Pinot noir",
		color: "red",
	},
	{ id: "gamay", nameJa: "ガメイ", nameLocal: "Gamay", color: "red" },
	{ id: "cesar", nameJa: "セザール", nameLocal: "César", color: "red" },
	{ id: "tressot", nameJa: "トレソ", nameLocal: "Tressot", color: "red" },
	{
		id: "chardonnay",
		nameJa: "シャルドネ",
		nameLocal: "Chardonnay",
		color: "white",
	},
	{ id: "aligote", nameJa: "アリゴテ", nameLocal: "Aligoté", color: "white" },
	{
		id: "sauvignon-blanc",
		nameJa: "ソーヴィニヨン・ブラン",
		nameLocal: "Sauvignon blanc",
		color: "white",
	},
	{
		id: "sauvignon-gris",
		nameJa: "ソーヴィニヨン・グリ",
		nameLocal: "Sauvignon gris",
		color: "white",
	},
	{
		id: "pinot-blanc",
		nameJa: "ピノ・ブラン",
		nameLocal: "Pinot blanc",
		color: "white",
	},
	{
		id: "pinot-gris",
		nameJa: "ピノ・グリ",
		nameLocal: "Pinot gris",
		color: "white",
	},
	{ id: "melon", nameJa: "ムロン", nameLocal: "Melon", color: "white" },
	{ id: "sacy", nameJa: "サシー", nameLocal: "Sacy", color: "white" },
	{ id: "meunier", nameJa: "ムニエ", nameLocal: "Meunier", color: "red" },
	{ id: "arbane", nameJa: "アルバンヌ", nameLocal: "Arbane", color: "white" },
	{
		id: "petit-meslier",
		nameJa: "プティ・メリエ",
		nameLocal: "Petit Meslier",
		color: "white",
	},
	// --- イタリア(ピエモンテ) ---
	{
		id: "nebbiolo",
		nameJa: "ネッビオーロ",
		nameLocal: "Nebbiolo",
		color: "red",
	},
	{ id: "barbera", nameJa: "バルベーラ", nameLocal: "Barbera", color: "red" },
	{
		id: "dolcetto",
		nameJa: "ドルチェット",
		nameLocal: "Dolcetto",
		color: "red",
	},
	{
		id: "brachetto",
		nameJa: "ブラケット",
		nameLocal: "Brachetto",
		color: "red",
	},
	{ id: "ruche", nameJa: "ルケ", nameLocal: "Ruchè", color: "red" },
	{ id: "freisa", nameJa: "フレイザ", nameLocal: "Freisa", color: "red" },
	{
		id: "grignolino",
		nameJa: "グリニョリーノ",
		nameLocal: "Grignolino",
		color: "red",
	},
	{
		id: "pelaverga",
		nameJa: "ペラヴェルガ",
		nameLocal: "Pelaverga",
		color: "red",
	},
	{
		id: "croatina",
		nameJa: "クロアティーナ",
		nameLocal: "Croatina",
		color: "red",
	},
	{
		id: "vespolina",
		nameJa: "ヴェスポリーナ",
		nameLocal: "Vespolina",
		color: "red",
	},
	{
		id: "uva-rara",
		nameJa: "ウーヴァ・ラーラ",
		nameLocal: "Uva Rara",
		color: "red",
	},
	{
		id: "moscato-bianco",
		nameJa: "モスカート・ビアンコ",
		nameLocal: "Moscato Bianco",
		color: "white",
	},
	{ id: "cortese", nameJa: "コルテーゼ", nameLocal: "Cortese", color: "white" },
	{ id: "arneis", nameJa: "アルネイス", nameLocal: "Arneis", color: "white" },
	{
		id: "erbaluce",
		nameJa: "エルバルーチェ",
		nameLocal: "Erbaluce",
		color: "white",
	},
	{
		id: "timorasso",
		nameJa: "ティモラッソ",
		nameLocal: "Timorasso",
		color: "white",
	},
	// ボルドー系(赤): メドック/グラーヴ/リブルネのブレンド主体
	{
		id: "cabernet-sauvignon",
		nameJa: "カベルネ・ソーヴィニヨン",
		nameLocal: "Cabernet sauvignon",
		color: "red",
	},
	{ id: "merlot", nameJa: "メルロ", nameLocal: "Merlot", color: "red" },
	{
		id: "cabernet-franc",
		nameJa: "カベルネ・フラン",
		nameLocal: "Cabernet franc",
		color: "red",
	},
	{
		id: "petit-verdot",
		nameJa: "プティ・ヴェルド",
		nameLocal: "Petit verdot",
		color: "red",
	},
	{
		id: "malbec",
		nameJa: "マルベック(コット)",
		nameLocal: "Malbec",
		color: "red",
	},
	{
		id: "carmenere",
		nameJa: "カルメネール",
		nameLocal: "Carménère",
		color: "red",
	},
	// ボルドー系(白): グラーヴの辛口白・ソーテルヌの貴腐甘口。ソーヴィニヨンは既出
	{ id: "semillon", nameJa: "セミヨン", nameLocal: "Sémillon", color: "white" },
	{
		id: "muscadelle",
		nameJa: "ミュスカデル",
		nameLocal: "Muscadelle",
		color: "white",
	},
];

export const GRAPE_VARIETY_IDS = GRAPE_VARIETIES.map((v) => v.id);

export function getVariety(id: string): GrapeVariety | undefined {
	return GRAPE_VARIETIES.find((v) => v.id === id);
}
