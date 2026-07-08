import type { Region } from "./types";

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
		enabled: false,
		subregions: [],
		description:
			"バローロ・バルバレスコを擁するネッビオーロの銘醸地。" +
			"DOC/DOCGの統一境界データが公開され次第対応予定。",
	},
	{
		id: "bordeaux",
		nameJa: "ボルドー",
		nameLocal: "Bordeaux",
		country: "France",
		countryJa: "フランス",
		enabled: false,
		subregions: [],
		description: "カベルネ・ソーヴィニヨンとメルロのブレンドの本場。対応予定。",
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
];

export function getRegion(id: string): Region | undefined {
	return REGIONS.find((r) => r.id === id);
}
