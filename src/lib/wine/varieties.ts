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
	// --- イタリア(トスカーナ) ---
	// サンジョヴェーゼはキアンティ/ブルネッロ/ヴィーノ・ノービレ等トスカーナ赤の中核。
	{
		id: "sangiovese",
		nameJa: "サンジョヴェーゼ",
		nameLocal: "Sangiovese",
		color: "red",
	},
	{
		id: "canaiolo",
		nameJa: "カナイオーロ",
		nameLocal: "Canaiolo Nero",
		color: "red",
	},
	{
		id: "ciliegiolo",
		nameJa: "チリエジョーロ",
		nameLocal: "Ciliegiolo",
		color: "red",
	},
	{ id: "colorino", nameJa: "コロリーノ", nameLocal: "Colorino", color: "red" },
	{ id: "mammolo", nameJa: "マンモロ", nameLocal: "Mammolo", color: "red" },
	{
		id: "aleatico",
		nameJa: "アレアティコ",
		nameLocal: "Aleatico",
		color: "red",
	},
	{
		id: "vernaccia",
		nameJa: "ヴェルナッチャ",
		nameLocal: "Vernaccia di San Gimignano",
		color: "white",
	},
	{
		// トスカーナのトレッビアーノ・トスカーノ(≒ユニ・ブラン)。伊表記の一貫性のため
		// 独立エントリとして持つ。
		id: "trebbiano",
		nameJa: "トレッビアーノ",
		nameLocal: "Trebbiano Toscano",
		color: "white",
	},
	{
		id: "malvasia",
		nameJa: "マルヴァジーア",
		nameLocal: "Malvasia Bianca Lunga",
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
	{
		id: "riesling",
		nameJa: "リースリング",
		nameLocal: "Riesling",
		color: "white",
	},
	{
		id: "gewurztraminer",
		nameJa: "ゲヴュルツトラミネール",
		nameLocal: "Gewurztraminer",
		color: "white",
	},
	{
		id: "sylvaner",
		nameJa: "シルヴァネール",
		nameLocal: "Sylvaner",
		color: "white",
	},
	{
		id: "muscat-blanc-a-petits-grains",
		nameJa: "ミュスカ・ブラン・ア・プティ・グラン",
		nameLocal: "Muscat blanc à petits grains",
		color: "white",
	},
	{
		id: "muscat-rose-a-petits-grains",
		nameJa: "ミュスカ・ローズ・ア・プティ・グラン",
		nameLocal: "Muscat rosé à petits grains",
		color: "white",
	},
	{
		id: "muscat-ottonel",
		nameJa: "ミュスカ・オットネル",
		nameLocal: "Muscat Ottonel",
		color: "white",
	},
	{
		id: "auxerrois",
		nameJa: "オーセロワ",
		nameLocal: "Auxerrois",
		color: "white",
	},
	{
		id: "chasselas",
		nameJa: "シャスラ",
		nameLocal: "Chasselas",
		color: "white",
	},
	{
		id: "savagnin-rose",
		nameJa: "サヴァニャン・ローズ(クレヴネール)",
		nameLocal: "Savagnin rose",
		color: "white",
	},
	// --- ロワール ---
	// (シュナン・ブラン=白ワインの主役、カベルネ・フランやソーヴィニヨンは既出)
	{
		id: "chenin",
		nameJa: "シュナン・ブラン",
		nameLocal: "Chenin blanc",
		color: "white",
	},
	{ id: "grolleau", nameJa: "グロロー", nameLocal: "Grolleau", color: "red" },
	{
		id: "folle-blanche",
		nameJa: "フォル・ブランシュ(グロ・プラン)",
		nameLocal: "Folle blanche",
		color: "white",
	},
	{
		id: "pineau-d-aunis",
		nameJa: "ピノー・ドニ",
		nameLocal: "Pineau d'Aunis",
		color: "red",
	},
	{
		id: "romorantin",
		nameJa: "ロモランタン",
		nameLocal: "Romorantin",
		color: "white",
	},
	{
		id: "menu-pineau",
		nameJa: "ムニュ・ピノー(オルボワ)",
		nameLocal: "Menu pineau",
		color: "white",
	},
	// --- ローヌ ---
	// 北ローヌの赤はシラー単体、白はマルサンヌ/ルーサンヌ/ヴィオニエ。
	// 南ローヌの赤はグルナッシュ主体のGSMブレンド。シャトーヌフ・デュ・パプの
	// 認可13品種(赤白)も含む。
	{ id: "syrah", nameJa: "シラー", nameLocal: "Syrah", color: "red" },
	{
		id: "grenache",
		nameJa: "グルナッシュ(ノワール)",
		nameLocal: "Grenache noir",
		color: "red",
	},
	{
		id: "mourvedre",
		nameJa: "ムールヴェードル",
		nameLocal: "Mourvèdre",
		color: "red",
	},
	{ id: "cinsault", nameJa: "サンソー", nameLocal: "Cinsault", color: "red" },
	{ id: "carignan", nameJa: "カリニャン", nameLocal: "Carignan", color: "red" },
	{ id: "counoise", nameJa: "クノワーズ", nameLocal: "Counoise", color: "red" },
	{
		id: "muscardin",
		nameJa: "ミュスカルダン",
		nameLocal: "Muscardin",
		color: "red",
	},
	{
		id: "vaccarese",
		nameJa: "ヴァカレーズ(ブラン・アルジャンテ)",
		nameLocal: "Vaccarèse",
		color: "red",
	},
	{
		id: "terret-noir",
		nameJa: "テレ・ノワール",
		nameLocal: "Terret noir",
		color: "red",
	},
	{
		id: "piquepoul-noir",
		nameJa: "ピクプール・ノワール",
		nameLocal: "Piquepoul noir",
		color: "red",
	},
	{
		id: "grenache-gris",
		nameJa: "グルナッシュ・グリ",
		nameLocal: "Grenache gris",
		color: "red",
	},
	{
		id: "viognier",
		nameJa: "ヴィオニエ",
		nameLocal: "Viognier",
		color: "white",
	},
	{
		id: "marsanne",
		nameJa: "マルサンヌ",
		nameLocal: "Marsanne",
		color: "white",
	},
	{
		id: "roussanne",
		nameJa: "ルーサンヌ",
		nameLocal: "Roussanne",
		color: "white",
	},
	{
		id: "clairette",
		nameJa: "クレレット",
		nameLocal: "Clairette",
		color: "white",
	},
	{
		id: "bourboulenc",
		nameJa: "ブルブーラン",
		nameLocal: "Bourboulenc",
		color: "white",
	},
	{
		id: "grenache-blanc",
		nameJa: "グルナッシュ・ブラン",
		nameLocal: "Grenache blanc",
		color: "white",
	},
	{
		id: "piquepoul-blanc",
		nameJa: "ピクプール・ブラン",
		nameLocal: "Piquepoul blanc",
		color: "white",
	},
	{
		id: "picardan",
		nameJa: "ピカルダン",
		nameLocal: "Picardan",
		color: "white",
	},
	{
		id: "ugni-blanc",
		nameJa: "ユニ・ブラン",
		nameLocal: "Ugni blanc",
		color: "white",
	},
	{
		id: "vermentino",
		nameJa: "ヴェルメンティーノ(ロール)",
		nameLocal: "Vermentino",
		color: "white",
	},
];

export const GRAPE_VARIETY_IDS = GRAPE_VARIETIES.map((v) => v.id);

export function getVariety(id: string): GrapeVariety | undefined {
	return GRAPE_VARIETIES.find((v) => v.id === id);
}
