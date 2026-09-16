import type { Region } from "./types";
import { REGION_ID_LIST } from "./types";

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
		id: "toscana",
		nameJa: "トスカーナ",
		nameLocal: "Toscana",
		country: "Italy",
		countryJa: "イタリア",
		enabled: true,
		// build:geodata:eu の出力値を反映(トスカーナ本土＋エルバ島を含む)。
		bounds: [10.01877, 42.23824, 12.22372, 44.23988],
		geojsonPath: "/data/aop/toscana.geojson",
		boundariesPath: "/data/aop/toscana-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		subregions: [
			{ id: "chianti", nameJa: "キアンティ" },
			{ id: "montalcino", nameJa: "モンタルチーノ" },
			{ id: "montepulciano", nameJa: "モンテプルチャーノ" },
			{ id: "san-gimignano", nameJa: "サン・ジミニャーノ" },
			{ id: "costa-maremma", nameJa: "トスカーナ海岸 / マレンマ" },
			{ id: "colline-centrali", nameJa: "中部・北部の丘陵" },
			// 州全域に及ぶ広域呼称(IGT)の受け皿。地理的な地区ではないため
			// `-regional` 接尾辞を付ける(ボルドーの bordeaux-regional と同じ規約で、
			// 境界GeoJSON・所属地区クイズの対象から自動的に外れる)。#212
			{ id: "toscana-regional", nameJa: "広域呼称(IGT)" },
		],
		description:
			"サンジョヴェーゼを主役に、キアンティ・クラッシコ、ブルネッロ・ディ・" +
			"モンタルチーノ、ヴィーノ・ノービレ・ディ・モンテプルチャーノを擁する" +
			"イタリア中部の銘醸地。ボルドー品種主体のボルゲリ(スーパートスカーナ)や" +
			"白のヴェルナッチャ・ディ・サン・ジミニャーノまで、DOCG11・DOC17に" +
			"加え、DOC(G)の枠外で造られるスーパートスカーナの受け皿となる" +
			"トスカーナIGTを収録。" +
			"ピエモンテ同様、境界はコミューン単位で集約された学術データセット" +
			"(Candiago et al. 2022, CC0)に基づく概略値。",
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
	{
		id: "rhone",
		nameJa: "ローヌ",
		nameLocal: "Rhône",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		bounds: [4.24548, 43.62018, 6.07102, 45.52738],
		geojsonPath: "/data/aop/rhone.geojson",
		boundariesPath: "/data/aop/rhone-boundaries.geojson",
		subregions: [
			{ id: "rhone-septentrional", nameJa: "北ローヌ(セプタントリオナル)" },
			{ id: "rhone-meridional", nameJa: "南ローヌ(メリディオナル)" },
			{ id: "rhone-peripherique", nameJa: "周辺(ディオワ・衛星産地)" },
			{ id: "rhone-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"ローヌ川に沿って南北に伸びる、ボルドー・ブルゴーニュと並ぶフランスの銘醸地。" +
			"急斜面でシラー単一の力強い赤とヴィオニエ/マルサンヌ/ルーサンヌの白を生む北ローヌと、" +
			"グルナッシュを主体にシラー・ムールヴェードルを混ぜるGSMブレンドの南ローヌ(シャトーヌフ・" +
			"デュ・パプ等)という、同じ川筋で対照的な二つの世界を軸に、単一品種とブレンドの学習に最適。",
	},
	{
		id: "rioja",
		nameJa: "リオハ / エブロ川流域",
		nameLocal: "Rioja / Valle del Ebro",
		country: "Spain",
		countryJa: "スペイン",
		enabled: true,
		// build:geodata:eu の出力値を反映。
		bounds: [-3.13429, 41.082, 0.51572, 42.89239],
		geojsonPath: "/data/aop/rioja.geojson",
		boundariesPath: "/data/aop/rioja-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		// 地区はエブロ川上流から中流にかけての行政区分(ラ・リオハ州/ナバーラ州/
		// アラゴン州)で切る。DOCaリオハはラ・リオハ州・アラバ県・ナバーラ州の
		// 3州にまたがるが、呼称としては1つなので rioja 地区に置く。
		subregions: [
			{ id: "rioja", nameJa: "リオハ" },
			{ id: "navarra", nameJa: "ナバーラ" },
			{ id: "aragon", nameJa: "アラゴン" },
		],
		description:
			"スペイン最上級の格付けDOCaを持つリオハを筆頭に、エブロ川に沿って" +
			"ナバーラ・アラゴンへと連なるスペイン随一の銘醸地帯。テンプラニーリョと" +
			"ガルナッチャ(=グルナッシュ)という2大品種の対比に加え、州全域を覆う" +
			"DO・DOCaと、単一のぶどう畑だけに与えられる最上位のVino de Pago" +
			"(パゴ・デ・アリンサノ等)が同居する、スペイン独自のDOP階層を" +
			"地図で学べる。境界はイタリア同様、コミューン単位で集約された学術" +
			"データセット(Candiago et al. 2022, CC0)に基づく概略値。",
	},
	{
		id: "portugal",
		nameJa: "ポルトガル",
		nameLocal: "Portugal",
		country: "Portugal",
		countryJa: "ポルトガル",
		enabled: true,
		// build:geodata:eu の出力値を反映(本土のみ。マデイラ・アゾレスは除外)。
		bounds: [-9.50053, 37.7412, -6.18935, 42.15442],
		geojsonPath: "/data/aop/portugal.geojson",
		boundariesPath: "/data/aop/portugal-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		// 地区はIVVの公式ワイン生産地方(região vitivinícola)に沿って北から南へ切る。
		// DOPの数が1〜2しかない地方(ミーニョ・テージョ・アレンテージョ)も、
		// 地理的に独立しているのでまとめずそのまま地区にする。
		subregions: [
			{ id: "minho", nameJa: "ミーニョ(ヴィーニョ・ヴェルデ)" },
			{ id: "douro-tras-os-montes", nameJa: "ドウロ / トラス・オス・モンテス" },
			{ id: "beiras", nameJa: "ベイラ(ダン / バイラーダ)" },
			{ id: "lisboa", nameJa: "リスボア" },
			{ id: "tejo", nameJa: "テージョ" },
			{ id: "peninsula-de-setubal", nameJa: "セトゥーバル半島" },
			{ id: "alentejo", nameJa: "アレンテージョ" },
		],
		description:
			"ポルトガル本土の21のDOPを1つの地方として収録。大西洋に面した冷涼な" +
			"ヴィーニョ・ヴェルデから、片岩の段々畑でポルトとドウロを生む北東部、" +
			"花崗岩のダン、粘土石灰質のバイラーダ、石灰質のリスボア、川沿いのテージョ、" +
			"砂地のセトゥーバル半島、そして広大なアレンテージョまで、南北約580kmに" +
			"多様な気候と土壌が並ぶ。トゥリガ・ナシオナルやアリントをはじめ土着品種の" +
			"比率が極めて高いのが最大の特徴で、ポルト・セトゥーバル・カルカヴェロスの" +
			"3つの酒精強化ワインも学べる。境界はイタリア・スペイン同様、コミューン" +
			"単位で集約された学術データセット(Candiago et al. 2022, CC0)に基づく概略値。",
	},
	{
		id: "deutschland",
		nameJa: "ドイツ",
		nameLocal: "Deutschland",
		country: "Germany",
		countryJa: "ドイツ",
		enabled: true,
		// build:geodata:eu の出力値を反映(モーゼル西端〜ザクセン東端)。
		bounds: [6.35695, 47.53238, 14.96466, 51.93941],
		geojsonPath: "/data/aop/deutschland.geojson",
		boundariesPath: "/data/aop/deutschland-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		// 地区は13のアンバウゲビート(産地単位のg.U.)を水系・地理でまとめたもの。
		// ドイツのg.U.はアンバウゲビートが最小単位で、その下のベライヒ/オルツ/
		// アインツェルラーゲは呼称ではなく産地表示の階層なので地区にはしない。
		subregions: [
			{ id: "mosel", nameJa: "モーゼル(ザール・ルーヴァー)" },
			{ id: "mittelrhein-ahr", nameJa: "ミッテルライン / アール" },
			{ id: "rheingau-nahe", nameJa: "ラインガウ / ナーエ" },
			{
				id: "rheinhessen-pfalz",
				nameJa: "ラインヘッセン / プファルツ / ベルクシュトラーセ",
			},
			{ id: "franken", nameJa: "フランケン" },
			{ id: "baden-wuerttemberg", nameJa: "バーデン / ヴュルテンベルク" },
			{ id: "ost", nameJa: "東部(ザーレ・ウンストルート / ザクセン)" },
		],
		description:
			"リースリングの故郷。北緯50度前後という高緯度で日照を稼ぐため、川沿いの" +
			"急斜面に畑を刻んできたのがドイツワインの原点で、モーゼルのスレートから" +
			"フランケンの貝殻石灰岩、バーデンの火山性土壌まで13の指定栽培地域" +
			"(アンバウゲビート)がそれぞれ独立したg.U.になっている。収穫時の果汁糖度で" +
			"格付けするプレディカーツ(カビネット〜トロッケンベーレンアウスレーゼ)という" +
			"独自の階層に加え、ウーレンやビュルクシュタッター・ベルクのように単一畑" +
			"そのものがg.U.として登録された区画も収録する。境界はイタリア・スペインと" +
			"同じくコミューン単位で集約された学術データセット" +
			"(Candiago et al. 2022, CC0)に基づく概略値で、単一畑のg.U.も" +
			"畑の区画ではなく畑のある自治体の輪郭になる。",
	},
	{
		id: "languedoc-roussillon",
		nameJa: "ラングドック・ルーション",
		nameLocal: "Languedoc-Roussillon",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		// build:geodata の出力値を反映(西端リムー〜東端カマルグ、南端バニュルス〜
		// 北端テラス・デュ・ラルザック)。
		bounds: [1.94257, 42.40481, 4.64454, 43.9946],
		geojsonPath: "/data/aop/languedoc-roussillon.geojson",
		boundariesPath: "/data/aop/languedoc-roussillon-boundaries.geojson",
		// 地区はINAOの délégation territoriale(Narbonne / Montpellier)と県の
		// 区切りに沿って西から東、そして国境側のルーションへと切る。ミュスカ・ド・
		// サン・ジャン・ド・ミネルヴォワはエロー県だが、ミネルヴォワの一部であり
		// INAOの délégation も Narbonne なのでオード側にまとめる。
		subregions: [
			{ id: "aude", nameJa: "オード(西ラングドック)" },
			{ id: "herault-gard", nameJa: "エロー / ガール(東ラングドック)" },
			{ id: "roussillon", nameJa: "ルーション" },
			{ id: "languedoc-regional", nameJa: "地方名AOC(広域)" },
		],
		description:
			"地中海沿いに弧を描く、フランス最大の栽培面積を持つ地方。グルナッシュ・" +
			"シラー・ムールヴェードル・カリニャン・サンソーによる赤が軸で、" +
			"コルビエールやミネルヴォワの広大な丘陵から、ブーテナック・" +
			"ラ・リヴィニエール・ピク・サン・ルー・テラス・デュ・ラルザックのような" +
			"限定された区域のAOCまで階層を持つ。ピレネーの東端に当たる南部の" +
			"ルーションは、バニュルス・モーリー・リヴザルトという天然甘口ワイン" +
			"(ヴァン・ドゥー・ナチュレル)の一大産地で、発酵途中の果汁にアルコールを" +
			"加えて糖を残し、酸化熟成によるランシオの香りを育てる。リムーには" +
			"瓶内二次発酵の起源とされるブランケットがあり、ピクプール・ド・ピネや" +
			"各地のミュスカも含めて、1つの地方の中でスタイルの幅が最も広い。",
	},
	{
		id: "veneto",
		nameJa: "ヴェネト",
		nameLocal: "Veneto",
		country: "Italy",
		countryJa: "イタリア",
		enabled: true,
		// build:geodata:eu の出力値を反映。
		bounds: [10.62297, 45.05561, 13.91866, 46.6806],
		geojsonPath: "/data/aop/veneto.geojson",
		boundariesPath: "/data/aop/veneto-boundaries.geojson",
		boundaryAttribution:
			"EU Wine PDO boundaries: Candiago et al. 2022 (Sci Data, CC0)",
		// 地区は州内の産地(行政区分ではなく地理と酒質のまとまり)で西から東へ切る。
		// ガンベッラーラとレッシーニはヴィチェンツァ県だが、ソアーヴェと同じ
		// 火山性土壌＋ガルガーネガ/ドゥレッラの帯なので soave-lessini に置く。
		// プロセッコDOCだけは9県2州に及ぶ広域呼称なので、既存の規約どおり
		// `-regional` 接尾辞の置き場へ回す(境界GeoJSON・所属地区クイズの対象から
		// 自動的に外れる。トスカーナの toscana-regional と同じ扱い)。
		subregions: [
			{ id: "valpolicella", nameJa: "ヴァルポリチェッラ" },
			{ id: "soave-lessini", nameJa: "ソアーヴェ / レッシーニ" },
			{ id: "garda-veronese", nameJa: "ガルダ / ヴェローナ西部" },
			{ id: "vicenza-berici", nameJa: "ヴィチェンツァ / ベリチ丘陵" },
			{ id: "padova-euganei", nameJa: "パドヴァ / エウガネイ丘陵" },
			{
				id: "treviso-prosecco",
				nameJa: "トレヴィーゾ(プロセッコ / ピアーヴェ)",
			},
			{ id: "venezia-orientale", nameJa: "ヴェネツィア東部(リゾン)" },
			{ id: "veneto-regional", nameJa: "広域DOC" },
		],
		description:
			"ガルダ湖からアドリア海まで東西に広がる、イタリア最大級の生産量を持つ州。" +
			"ピエモンテがネッビオーロ、トスカーナがサンジョヴェーゼという1品種を軸に" +
			"階層を学ぶ州なのに対し、ヴェネトは**製法の違い**で学ぶ州といえる。" +
			"収穫した房を数か月陰干し(appassimento)してから発酵させるヴァルポリチェッラの" +
			"アマローネとレチョート、その搾りかすで再発酵させるリパッソ、タンク内二次発酵で" +
			"造るプロセッコ、瓶内二次発酵のレッシーニ・ドゥレッロと、同じ州の中に" +
			"まったく異なる造りが並ぶ。品種も西のコルヴィーナ/ガルガーネガ、" +
			"東のグレーラ/ラボーゾ/タイと入れ替わり、火山性(ソアーヴェ・エウガネイ)・" +
			"氷堆石(バルドリーノ)・石灰岩(ベリチ)・沖積(ピアーヴェ)と土壌も対照的。" +
			"境界はピエモンテ・トスカーナ同様、コミューン単位で集約された学術データセット" +
			"(Candiago et al. 2022, CC0)に基づく概略値。",
	},
];

export function getRegion(id: string): Region | undefined {
	return REGIONS.find((r) => r.id === id);
}

// RegionId の一覧(SSOT は types.ts の REGION_ID_LIST)。クイズの地域スキーマ等が
// これを参照する。Region.id は RegionId 型のため、REGIONS と REGION_ID_LIST の
// メンバーの一致は data-integrity テストで担保する。
export const REGION_IDS = REGION_ID_LIST;
