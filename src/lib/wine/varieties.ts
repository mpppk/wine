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
	// --- スペイン(リオハ/エブロ川流域) ---
	// ガルナッチャ(Garnacha Tinta)・マスエロ(Mazuelo/Cariñena)・ガルナッチャ・ブランカは
	// それぞれ grenache / carignan / grenache-blanc と同一品種なので新設せず既存IDを再利用する
	// (同じ品種が別IDに割れると品種クイズ・品種フィルタが分断されるため)。現地名は
	// 各AOPの解説に併記する。
	{
		id: "tempranillo",
		nameJa: "テンプラニーリョ",
		nameLocal: "Tempranillo",
		color: "red",
	},
	{
		id: "graciano",
		nameJa: "グラシアーノ",
		nameLocal: "Graciano",
		color: "red",
	},
	{
		id: "maturana-tinta",
		nameJa: "マトゥラナ・ティンタ",
		nameLocal: "Maturana Tinta",
		color: "red",
	},
	{ id: "moristel", nameJa: "モリステル", nameLocal: "Moristel", color: "red" },
	{
		id: "parraleta",
		nameJa: "パラレタ",
		nameLocal: "Parraleta",
		color: "red",
	},
	{
		id: "viura",
		nameJa: "ビウラ(マカベオ)",
		nameLocal: "Viura",
		color: "white",
	},
	{
		id: "tempranillo-blanco",
		nameJa: "テンプラニーリョ・ブランコ",
		nameLocal: "Tempranillo Blanco",
		color: "white",
	},
	{
		id: "alcanon",
		nameJa: "アルカニョン",
		nameLocal: "Alcañón",
		color: "white",
	},
	{ id: "verdejo", nameJa: "ベルデホ", nameLocal: "Verdejo", color: "white" },
	// --- ポルトガル(本土) ---
	// アラゴネス(Aragonez)/ティンタ・ロリス(Tinta Roriz)はテンプラニーリョと同一品種
	// なので新設せず tempranillo を再利用する(各DOPの caderno de especificações の
	// 同義語欄が "Aragonez | Tinta-Roriz, Tempranillo" と明記している)。同様に
	// モスカテル・ガレゴ・ブランコ(= Muscat-à-Petits-Grains)は
	// muscat-blanc-a-petits-grains を使う。同じ品種が別IDに割れると品種クイズ・
	// 品種フィルタが分断されるため。現地でのシノニムは各AOPの解説に併記する。
	{
		id: "touriga-nacional",
		nameJa: "トゥリガ・ナシオナル",
		nameLocal: "Touriga Nacional",
		color: "red",
	},
	{
		id: "touriga-franca",
		nameJa: "トゥリガ・フランカ",
		nameLocal: "Touriga Franca",
		color: "red",
	},
	{
		id: "tinta-barroca",
		nameJa: "ティンタ・バロッカ",
		nameLocal: "Tinta Barroca",
		color: "red",
	},
	{
		id: "tinto-cao",
		nameJa: "ティント・カン",
		nameLocal: "Tinto Cão",
		color: "red",
	},
	// ヴィーニョ・ヴェルデでは Vinhão、ドウロ以南では Sousão と呼ぶ同一品種
	// (Vinho Verde / Beira Interior の caderno がシノニムとして併記している)。
	{
		id: "sousao",
		nameJa: "ソウザン(ヴィニャン)",
		nameLocal: "Sousão",
		color: "red",
	},
	{ id: "baga", nameJa: "バガ", nameLocal: "Baga", color: "red" },
	{
		id: "alfrocheiro",
		nameJa: "アルフロシェイロ",
		nameLocal: "Alfrocheiro",
		color: "red",
	},
	// スペイン・ビエルソのメンシアと同一品種。ポルトガルでは Jaen と呼ぶ。
	{ id: "jaen", nameJa: "ジャエン(メンシア)", nameLocal: "Jaen", color: "red" },
	{
		id: "rufete",
		nameJa: "ルフェテ(ティンタ・ピニェイラ)",
		nameLocal: "Rufete",
		color: "red",
	},
	{
		id: "trincadeira",
		nameJa: "トリンカデイラ(ティンタ・アマレラ)",
		nameLocal: "Trincadeira",
		color: "red",
	},
	{
		id: "castelao",
		nameJa: "カステラン(ペリキータ)",
		nameLocal: "Castelão",
		color: "red",
	},
	{
		id: "alicante-bouschet",
		nameJa: "アリカンテ・ブーシェ",
		nameLocal: "Alicante Bouschet",
		color: "red",
	},
	{ id: "ramisco", nameJa: "ラミスコ", nameLocal: "Ramisco", color: "red" },
	{
		id: "tinta-miuda",
		nameJa: "ティンタ・ミウダ",
		nameLocal: "Tinta Miúda",
		color: "red",
	},
	{ id: "camarate", nameJa: "カマラテ", nameLocal: "Camarate", color: "red" },
	{ id: "bastardo", nameJa: "バスタルド", nameLocal: "Bastardo", color: "red" },
	{ id: "amaral", nameJa: "アマラル", nameLocal: "Amaral", color: "red" },
	{
		id: "espadeiro",
		nameJa: "エスパデイロ",
		nameLocal: "Espadeiro",
		color: "red",
	},
	{ id: "padeiro", nameJa: "パデイロ", nameLocal: "Padeiro", color: "red" },
	{
		id: "alvarelhao",
		nameJa: "アルヴァレリャン(ブランセーリョ)",
		nameLocal: "Alvarelhão",
		color: "red",
	},
	{
		id: "marufo",
		nameJa: "マルフォ(モウリスコ・ロショ)",
		nameLocal: "Marufo",
		color: "red",
	},
	{
		id: "negra-mole",
		nameJa: "ネグラ・モーレ",
		nameLocal: "Negra Mole",
		color: "red",
	},
	// スペイン・リアスバイシャスのアルバリーニョと同一品種。ポルトガル側の
	// モンサン・エ・メルガッソが本拠で、現地表記は Alvarinho。
	{
		id: "alvarinho",
		nameJa: "アルヴァリーニョ(アルバリーニョ)",
		nameLocal: "Alvarinho",
		color: "white",
	},
	{
		id: "loureiro",
		nameJa: "ロウレイロ",
		nameLocal: "Loureiro",
		color: "white",
	},
	{
		id: "arinto",
		nameJa: "アリント(ペデルナン)",
		nameLocal: "Arinto",
		color: "white",
	},
	{
		id: "trajadura",
		nameJa: "トラジャドゥーラ(トレイシャドゥーラ)",
		nameLocal: "Trajadura",
		color: "white",
	},
	{ id: "avesso", nameJa: "アヴェッソ", nameLocal: "Avesso", color: "white" },
	{ id: "azal", nameJa: "アザル", nameLocal: "Azal", color: "white" },
	{
		id: "encruzado",
		nameJa: "エンクルザード",
		nameLocal: "Encruzado",
		color: "white",
	},
	{
		id: "bical",
		nameJa: "ビカル(ボラード・ダス・モスカス)",
		nameLocal: "Bical",
		color: "white",
	},
	{
		id: "malvasia-fina",
		nameJa: "マルヴァジア・フィナ(ボアル)",
		nameLocal: "Malvasia Fina",
		color: "white",
	},
	{ id: "rabigato", nameJa: "ラビガト", nameLocal: "Rabigato", color: "white" },
	{
		id: "viosinho",
		nameJa: "ヴィオジーニョ",
		nameLocal: "Viosinho",
		color: "white",
	},
	{
		id: "gouveio",
		nameJa: "ゴウヴェイオ",
		nameLocal: "Gouveio",
		color: "white",
	},
	{
		id: "codega-do-larinho",
		nameJa: "コデガ・ド・ラリーニョ",
		nameLocal: "Códega do Larinho",
		color: "white",
	},
	{
		id: "fernao-pires",
		nameJa: "フェルナン・ピレス(マリア・ゴメス)",
		nameLocal: "Fernão Pires",
		color: "white",
	},
	{
		id: "antao-vaz",
		nameJa: "アンタン・ヴァス",
		nameLocal: "Antão Vaz",
		color: "white",
	},
	{
		id: "siria",
		nameJa: "シリア(ロウペイロ/コデガ)",
		nameLocal: "Síria",
		color: "white",
	},
	{
		id: "rabo-de-ovelha",
		nameJa: "ラボ・デ・オヴェーリャ",
		nameLocal: "Rabo de Ovelha",
		color: "white",
	},
	{
		id: "verdelho",
		nameJa: "ヴェルデーリョ",
		nameLocal: "Verdelho",
		color: "white",
	},
	// モスカテル・グラウド(= モスカテル・デ・セトゥーバル)はマスカット・オブ・
	// アレキサンドリア。小粒種の muscat-blanc-a-petits-grains とは別品種。
	{
		id: "moscatel-graudo",
		nameJa: "モスカテル・グラウド(モスカテル・デ・セトゥーバル)",
		nameLocal: "Moscatel Graúdo",
		color: "white",
	},
	// 果皮がピンク色のモスカテル。ピノ・グリ等と同様、灰色系は white に分類する。
	{
		id: "moscatel-roxo",
		nameJa: "モスカテル・ロショ",
		nameLocal: "Moscatel Roxo",
		color: "white",
	},
	{ id: "vital", nameJa: "ヴィタル", nameLocal: "Vital", color: "white" },
	{
		id: "seara-nova",
		nameJa: "セアラ・ノヴァ",
		nameLocal: "Seara Nova",
		color: "white",
	},
	{
		id: "galego-dourado",
		nameJa: "ガレゴ・ドウラード",
		nameLocal: "Galego Dourado",
		color: "white",
	},
	{
		id: "ratinho",
		nameJa: "ラティーニョ",
		nameLocal: "Ratinho",
		color: "white",
	},
	// コラーレスの白を担う在来種。caderno は単に "Malvasia" と記すが、イタリアの
	// マルヴァジーア(malvasia = Malvasia Bianca Lunga)とは別品種のため独立IDにする。
	{
		id: "malvasia-de-colares",
		nameJa: "マルヴァジア・デ・コラーレス",
		nameLocal: "Malvasia de Colares",
		color: "white",
	},
	{
		id: "dona-branca",
		nameJa: "ドナ・ブランカ(フォーリャ・デ・フィゲイラ)",
		nameLocal: "Dona Branca",
		color: "white",
	},
	{
		id: "sercial",
		nameJa: "セルシアル(エスガナ・カン)",
		nameLocal: "Sercial",
		color: "white",
	},
	{
		id: "fonte-cal",
		nameJa: "フォンテ・カル",
		nameLocal: "Fonte Cal",
		color: "white",
	},
	// --- ドイツ ---
	// (リースリング=最重要品種、シルヴァーナー(Silvaner)・ピノ系(シュペート/
	//  ヴァイス/グラウブルグンダー)・シャスラ(Gutedel)・ムニエ(Schwarzriesling)・
	//  ゲヴュルツトラミネール(Traminer)はいずれも既出のIDを共有する)
	{
		id: "muller-thurgau",
		nameJa: "ミュラー・トゥルガウ",
		nameLocal: "Müller-Thurgau",
		color: "white",
	},
	{
		id: "elbling",
		nameJa: "エルプリング",
		nameLocal: "Elbling",
		color: "white",
	},
	{ id: "kerner", nameJa: "ケルナー", nameLocal: "Kerner", color: "white" },
	{
		id: "scheurebe",
		nameJa: "ショイレーベ",
		nameLocal: "Scheurebe",
		color: "white",
	},
	{ id: "bacchus", nameJa: "バッカス", nameLocal: "Bacchus", color: "white" },
	{
		id: "goldriesling",
		nameJa: "ゴールドリースリング",
		nameLocal: "Goldriesling",
		color: "white",
	},
	{
		id: "dornfelder",
		nameJa: "ドルンフェルダー",
		nameLocal: "Dornfelder",
		color: "red",
	},
	{
		id: "portugieser",
		nameJa: "ポルトギーザー",
		nameLocal: "Blauer Portugieser",
		color: "red",
	},
	// シュペートブルグンダー(ピノ・ノワール)の早熟な変異種。ドイツでは別品種として
	// 登録されており(Blauer Frühburgunder)、アールの特産。
	{
		id: "fruehburgunder",
		nameJa: "フリューブルグンダー",
		nameLocal: "Blauer Frühburgunder",
		color: "red",
	},
	{
		id: "lemberger",
		nameJa: "レンベルガー",
		nameLocal: "Lemberger (Blaufränkisch)",
		color: "red",
	},
	{
		id: "trollinger",
		nameJa: "トロリンガー",
		nameLocal: "Trollinger (Schiava)",
		color: "red",
	},
	{ id: "domina", nameJa: "ドミナ", nameLocal: "Domina", color: "red" },
	{
		id: "zweigelt",
		nameJa: "ツヴァイゲルト",
		nameLocal: "Blauer Zweigelt",
		color: "red",
	},
	// --- ラングドック・ルーション ---
	// GSM(グルナッシュ/シラー/ムールヴェードル)＋カリニャン・サンソーという骨格も、
	// 白のブールブーラン/クレレット/ルーサンヌ/マルサンヌ/ヴェルメンティーノ/
	// ピクプールも、ローヌ側で既に登録済みのIDをそのまま使う。以下はこの地方の
	// cahier des charges に現れて既存IDが無いものだけ。
	//
	// 既存IDを再利用するもの(同じ品種が別IDに割れると品種クイズ・品種フィルタが
	// 分断されるため。現地名は各AOPの解説に併記する):
	//   マカブー(macabeu B)           → viura(リオハのビウラと同一品種)
	//   コット(cot N)                 → malbec
	//   ミュスカ・ダレクサンドリー     → moscatel-graudo(マスカット・オブ・
	//     (muscat d'Alexandrie B、        アレキサンドリア。小粒種とは別品種)
	//      現地名 muscat romain)
	//   モラステル(morrastel N)       → graciano(フランス公式カタログ Plantgrape が
	//     スペインの Graciano・ポルトガルの Tinta Miúda と同一変種として登録)
	{
		// グルナッシュの葉裏に毛を持つ変異種だが、フランスの公式カタログでは
		// 別変種として登録され、cahier des charges でも grenache N と並記される。
		id: "lledoner-pelut",
		nameJa: "リェドネル・プリュ",
		nameLocal: "Lledoner Pelut",
		color: "red",
	},
	{
		id: "rivairenc",
		nameJa: "リヴェランク(アスピラン)",
		nameLocal: "Rivairenc",
		color: "red",
	},
	{
		// 南西地方のフェル・セルヴァドゥと同一。カバルデスの補助品種。
		id: "fer",
		nameJa: "フェル(フェル・セルヴァドゥ)",
		nameLocal: "Fer",
		color: "red",
	},
	{
		id: "carignan-blanc",
		nameJa: "カリニャン・ブラン",
		nameLocal: "Carignan blanc",
		color: "white",
	},
	{
		id: "terret-blanc",
		nameJa: "テレ・ブラン",
		nameLocal: "Terret blanc",
		color: "white",
	},
	{
		// ルーションの酒精強化白の骨格。現地名はマルヴォワジー・デュ・ルーション
		// だが、イタリア・ポルトガルのマルヴァジーア系とは別品種。
		id: "tourbat",
		nameJa: "トゥルバ(マルヴォワジー・デュ・ルーション)",
		nameLocal: "Tourbat",
		color: "white",
	},
	{
		// リムーの歴史的品種。ブランケット・ド・リムー(méthode ancestrale を含む)の
		// 主要品種で、南西地方のガイヤックとも共通する。
		id: "mauzac",
		nameJa: "モーザック",
		nameLocal: "Mauzac",
		color: "white",
	},
];

export const GRAPE_VARIETY_IDS = GRAPE_VARIETIES.map((v) => v.id);

export function getVariety(id: string): GrapeVariety | undefined {
	return GRAPE_VARIETIES.find((v) => v.id === id);
}
