import type { Region, RegionId } from "./types";

// 地域(地方)マスタ。enabled=false の地域は選択画面に「準備中」として並ぶ。
// bounds は scripts/build-aop-geodata.mjs が出力する値を貼り付ける。
export const REGIONS: Region[] = [
	{
		id: "bourgogne",
		nameJa: "ブルゴーニュ",
		nameLocal: "Bourgogne",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [3.35763, 45.82261, 5.102, 48.0601],
		geojsonPath: "/data/aop/bourgogne.geojson",
		boundariesPath: "/data/aop/bourgogne-boundaries.geojson",
		subregions: [
			{
				id: "chablis-grand-auxerrois",
				nameJa: "シャブリ / グラン・オーセロワ",
			},
			{ id: "cote-de-nuits", nameJa: "コート・ド・ニュイ" },
			{ id: "cote-de-beaune", nameJa: "コート・ド・ボーヌ" },
			{ id: "cote-chalonnaise", nameJa: "コート・シャロネーズ" },
			{ id: "maconnais", nameJa: "マコネ" },
			{ id: "bourgogne-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"ピノ・ノワールとシャルドネの聖地。グラン・クリュからレジョナルまで" +
			"重層的なAOC階層を持ち、クリマ(区画)ごとの個性を学ぶのに最適な地方。",
	},
	{
		id: "beaujolais",
		nameJa: "ボジョレー",
		nameLocal: "Beaujolais",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [4.41813, 45.82261, 4.81169, 46.28572],
		geojsonPath: "/data/aop/beaujolais.geojson",
		boundariesPath: "/data/aop/beaujolais-boundaries.geojson",
		subregions: [{ id: "beaujolais", nameJa: "ボジョレー" }],
		description:
			"ガメイ種の本拠地。花崗岩土壌の丘陵に10のクリュが連なり、" +
			"軽快なヌーヴォーから本格的なクリュ・ボジョレーまで幅広いスタイルを学べる。",
	},
	{
		id: "piemonte",
		nameJa: "ピエモンテ",
		nameLocal: "Piemonte",
		country: "Italy",
		countryJa: "イタリア",
		enabled: true,
		bounds: [6.84835, 44.14242, 9.21425, 46.29929],
		geojsonPath: "/data/aop/piemonte.geojson",
		boundariesPath: "/data/aop/piemonte-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		subregions: [
			{ id: "langhe", nameJa: "ランゲ" },
			{ id: "roero", nameJa: "ロエロ" },
			{ id: "monferrato-asti", nameJa: "モンフェッラート / アスティ" },
			{ id: "gavi-tortona", nameJa: "ガヴィ / トルトーナ" },
			{ id: "alto-piemonte", nameJa: "アルト・ピエモンテ" },
			{ id: "canavese", nameJa: "カナヴェーゼ" },
			{ id: "piemonte-regional", nameJa: "州名DOC(広域)" },
		],
		description:
			"バローロ・バルバレスコを擁するネッビオーロの銘醸地。DOCG18・DOC11を" +
			"収録。境界データはEU公式の区画GISが無いため、コミューン単位で集約された" +
			"学術データセット(Candiago et al. 2022, CC0)に基づく概略値。",
	},
	{
		id: "bordeaux",
		nameJa: "ボルドー",
		nameLocal: "Bordeaux",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [-1.1688, 44.32404, 0.31512, 45.57516],
		geojsonPath: "/data/aop/bordeaux.geojson",
		boundariesPath: "/data/aop/bordeaux-boundaries.geojson",
		subregions: [
			{ id: "medoc", nameJa: "メドック(左岸)" },
			{ id: "graves-sauternais", nameJa: "グラーヴ / ソーテルヌ" },
			{ id: "libournais", nameJa: "リブルネ(右岸)" },
			{ id: "entre-deux-mers", nameJa: "アントル・ドゥー・メール" },
			{ id: "bordeaux-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"カベルネ・ソーヴィニヨンとメルロのブレンドの本場。畑や村ではなく" +
			"シャトー単位で格付けが行われるのが特徴で、メドック/ソーテルヌの" +
			"1855年格付けとサンテミリオン格付けのシャトーを地図で学べる。",
	},
	{
		id: "alsace",
		nameJa: "アルザス",
		nameLocal: "Alsace",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [7.09082, 47.7914, 7.95264, 49.05447],
		geojsonPath: "/data/aop/alsace.geojson",
		boundariesPath: "/data/aop/alsace-boundaries.geojson",
		subregions: [
			{ id: "bas-rhin", nameJa: "バ・ラン(北部)" },
			{ id: "haut-rhin", nameJa: "オー・ラン(南部)" },
			{ id: "alsace-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"リースリングをはじめ単一品種ワインを名乗る文化の本場。ヴォージュ山脈東麓に" +
			"51のグラン・クリュ(リュー・ディ=畑)が点在し、多彩な土壌と品種の対応を学べる。",
	},
	{
		id: "champagne",
		nameJa: "シャンパーニュ",
		nameLocal: "Champagne",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [3.13668, 47.92368, 4.89491, 49.45536],
		geojsonPath: "/data/aop/champagne.geojson",
		boundariesPath: "/data/aop/champagne-boundaries.geojson",
		subregions: [
			{ id: "montagne-de-reims", nameJa: "モンターニュ・ド・ランス" },
			{ id: "vallee-de-la-marne", nameJa: "ヴァレ・ド・ラ・マルヌ" },
			{ id: "cote-des-blancs", nameJa: "コート・デ・ブラン" },
			{ id: "cote-de-sezanne", nameJa: "コート・ド・セザンヌ" },
			{ id: "cote-des-bar", nameJa: "コート・デ・バール" },
			{ id: "champagne-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"世界最高峰のスパークリングワインの本拠地。独立AOCではなく" +
			"「エシェル・デ・クリュ(村の格付け)」によるグラン・クリュ17村・" +
			"プルミエ・クリュ42村の階層を村単位の地図で学べる。",
	},
	{
		id: "loire",
		nameJa: "ロワール",
		nameLocal: "Loire",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [-2.17798, 46.361, 3.03083, 47.94275],
		geojsonPath: "/data/aop/loire.geojson",
		boundariesPath: "/data/aop/loire-boundaries.geojson",
		subregions: [
			{ id: "pays-nantais", nameJa: "ペイ・ナンテ" },
			{ id: "anjou-saumur", nameJa: "アンジュー・ソーミュール" },
			{ id: "touraine", nameJa: "トゥーレーヌ" },
			{ id: "centre-loire", nameJa: "サントル・ロワール" },
			{ id: "loire-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"フランス最長のロワール川に沿って東西に広がる、多様性の宝庫。" +
			"シュナン・ブランとカベルネ・フランを軸に、河口のミュスカデ(辛口白)から" +
			"アンジューの甘口・ソーミュールの発泡、トゥーレーヌの赤白、" +
			"上流サントルのソーヴィニヨン・ブラン(サンセール/プイィ・フュメ)まで、" +
			"4つの地区でまったく異なるスタイルと品種の対応を学べる。",
	},
];

export function getRegion(id: string): Region | undefined {
	return REGIONS.find((r) => r.id === id);
}

// 地域マスタから導出した RegionId の一覧。クイズの地域スキーマ等がこれを参照し、
// 新地域を REGIONS に追加すれば自動的に出題対象に取り込まれるようにする。
export const REGION_IDS = REGIONS.map((r) => r.id) as [RegionId, ...RegionId[]];
