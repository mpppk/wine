// 生産者に関する簡単な解説と公式サイト。生産者名クリック時の購入リンク
// ダイアログ(AopDetailPanel の ProducerPurchaseDialog)で表示する。
//
// 同じ生産者が複数の畑・村に登場するため、aops.json 側にインラインで持たせると
// 解説・URLが重複する。affiliate.ts の PRODUCER_SEARCH_KEYWORDS と同様、生産者名を
// キーにした共通辞書としてここで一元管理する。
//
// キーは aops.json の producers に現れる表記そのものと一致させること
// (data-integrity テストで参照整合性を検証する)。

export interface ProducerInfo {
	/** 生産者の簡単な解説(日本語・1〜2文) */
	description: string;
	/** 公式サイトのURL。存在する場合のみ。アフィリエイトではない一次情報リンク */
	officialWebsite?: string;
}

/**
 * ミシュランガイドが2026年に初めて発表したブルゴーニュ格付け「MICHELIN Grapes」の
 * 選出生産者一覧(全94生産者)を掲載した公式記事。
 *
 * ミシュラン側に生産者ごとの個別ページは存在せず、全生産者がこの1記事内のカードとして
 * のみ掲載されている(2026-07 時点。個別ページ・アンカーによるディープリンクも不可)。
 * そのため PRODUCER_INFO の各生産者(いずれも MICHELIN Grapes 選出)ダイアログでは、
 * 掲載元としてこの共通記事へのリンクを表示する。日本語版は存在せず英語(gb/en)のみ。
 */
export const MICHELIN_GRAPES_ARTICLE_URL =
	"https://guide.michelin.com/gb/en/article/wine/the-michelin-guide-s-burgundy-wine-selection";

/**
 * 生産者名 → 解説・公式サイト。
 *
 * 初期データは、ミシュランガイドが2026年に初めて発表したブルゴーニュ格付け
 * 「MICHELIN Grapes」で最高評価(3グレープ)を獲得した9生産者。解説・公式サイトの
 * 有無はいずれもウェブ調査で確認済み。DRC・ルロワなど公式サイトを持たない造り手は
 * officialWebsite を省略する。
 *
 * この辞書のエントリはいずれも MICHELIN Grapes 選出生産者であり、ダイアログでは
 * 共通の掲載記事(MICHELIN_GRAPES_ARTICLE_URL)へのリンクを表示する。
 */
export const PRODUCER_INFO: Record<string, ProducerInfo> = {
	"Domaine de la Romanée-Conti": {
		description:
			"ヴォーヌ・ロマネに本拠を置くドメーヌで、ロマネ・コンティとラ・ターシュを単独所有する。ビオディナミを採用し、グラン・クリュを中心に長命な赤ワインと少量の白を産する。",
		officialWebsite: "https://www.romanee-conti.fr/",
	},
	"Domaine Leroy": {
		description:
			"ヴォーヌ・ロマネに本拠を置くビオディナミ栽培の造り手。1988年に設立され、極めて低い収量による凝縮した赤ワインを中心に、複数のグラン・クリュを産する。",
		officialWebsite: "https://domaine-leroy.fr/",
	},
	"Domaine d'Auvenay": {
		description:
			"ラルー・ビーズ・ルロワが所有するサン・ロマンの微小規模ドメーヌ。ビオディナミ農法により、白・赤の特級を含む小さな区画から極少量のワインを生産する。",
	},
	"Domaine Coche-Dury": {
		description:
			"ムルソーを本拠とする白ワインの造り手。ムルソーの各1級やコルトン・シャルルマーニュを手がけ、還元的な醸造による凝縮感とミネラル感、長期熟成能力で高く評価される。",
	},
	"Domaine Georges Roumier": {
		description:
			"シャンボール・ミュジニーを本拠とするドメーヌで、クリストフ・ルーミエが運営。ボンヌ・マールやミュジニーを擁し、繊細で長期熟成に向く赤で高く評価される。",
		officialWebsite: "https://www.roumier.com/",
	},
	"Domaine Dugat-Py": {
		description:
			"ジュヴレ・シャンベルタンを本拠とする家族経営ドメーヌ。有機・ビオディナミ栽培と古樹から凝縮感のある力強い赤を造り、シャルムやマジ・シャンベルタンなどのグラン・クリュで知られる。",
		officialWebsite: "http://www.dugat-py.com/",
	},
	"Domaine Cécile Tremblay": {
		description:
			"2003年設立、ヴォーヌ・ロマネを拠点とする小規模生産者。相続した古樹の畑を有機・ビオディナミ栽培で手がけ、繊細で芳香高い赤ワインで近年高く評価される。",
		officialWebsite: "https://www.domaine-ceciletremblay.fr/",
	},
	"Domaine Jean-Marc & Thomas Bouley": {
		description:
			"ヴォルネイに本拠を置く家族経営のドメーヌ。ヴォルネイとポマールの赤(ピノ・ノワール)を主体とし、クロ・デ・シェーヌやカイユレなどの1級畑で知られる。",
		officialWebsite: "https://www.jean-marc-bouley.com/",
	},
	"Domaine Hubert Lamy": {
		description:
			"サン・トーバンを本拠とする白ワインの造り手。オリヴィエ・ラミが高密植栽培(オート・ダンシテ)を用い、ミネラル感のある辛口白を生産する。",
		officialWebsite: "https://www.domainehubertlamy.com/",
	},
	// ── MICHELIN Grapes 2グレープ（Two Grapes） ──
	"Domaine Denis Mortet": {
		description:
			"ジュヴレ・シャンベルタンの家族経営ドメーヌ。2006年の当主ドニ・モルテ没後は息子アルノーらが継承し、特級シャンベルタンを筆頭とする力強い赤ワインを造る。",
		officialWebsite: "https://www.domaine-denis-mortet.com/",
	},
	"Domaine Dujac": {
		description:
			"モレ・サン・ドニに本拠を置き、1968年にジャック・セイスが創設した造り手。現在は息子のジェレミーとアレック兄弟らが運営し、全房発酵による繊細な赤ワインで知られる。",
		officialWebsite: "https://www.dujac.com/",
	},
	"Domaine Georges Mugneret-Gibourg": {
		description:
			"ヴォーヌ・ロマネに拠点を置く家族経営ドメーヌ。ミュニュレ姉妹が営み、リュショット・シャンベルタンやクロ・ド・ヴジョ、エシェゾーなどコート・ド・ニュイの銘醸を手がける。",
		officialWebsite: "https://www.mugneret-gibourg.com/en/",
	},
	"Domaine Bruno Clair": {
		description:
			"マルサネ・ラ・コートに本拠を置く家族ドメーヌ。名門クレール・ダジュを継ぐブリュノ・クレールが1979年に創設し、マルサネやジュヴレ、コルトン周辺に幅広い畑を所有する。",
		officialWebsite: "https://www.brunoclair.com/",
	},
	"Domaine Gérard Mugneret": {
		description:
			"ヴォーヌ・ロマネに本拠を置く家族経営ドメーヌ。現当主パスカル・ミュニュレが運営し、エシェゾー特級やヴォーヌ・ロマネの村名・1級を中心に、繊細でエレガントな赤ワインを産する。",
		officialWebsite: "https://www.gerard-mugneret.fr",
	},
	"Domaine Jacques-Frédéric Mugnier": {
		description:
			"シャンボール・ミュジニーのシャトーに拠点を置く家族経営ドメーヌ。当主フレデリック・ミュニエが、ミュジニーやボンヌ・マール、モノポールのクロ・ド・ラ・マレシャルなどを手がける。",
		officialWebsite: "https://mugnier.fr",
	},
	"Domaine Paul Pillot": {
		description:
			"シャサーニュ・モンラッシェを拠点に、ティエリーとクリステル・ピヨ兄妹が営む家族経営のドメーヌ。シャルドネ主体でテロワールを映す繊細な白ワインで知られる。",
	},
	"Domaine Arnaud Ente": {
		description:
			"ムルソーに本拠を置く小規模ドメーヌ。1992年にアルノー・アントが設立し、現在は息子ピエールも参画。約4haを所有し、シャルドネ主体で純度と均衡を重んじた白ワインを造る。",
		officialWebsite: "https://www.arnaudente.fr/",
	},
	"Domaine Jean-Claude Bachelet et Fils": {
		description:
			"サン=トーバンを拠点とする家族経営の造り手。シャサーニュやピュリニーにも畑を持ち、ベノワとジャン=バティスト兄弟がビオディナミでシャルドネ主体の白を中心に手がける。",
	},
	"Domaine Benoît Ente": {
		description:
			"ピュリニー・モンラッシェ村を拠点とする白ワインの造り手。アルノー・アンテの弟ブノワ・アンテが営む家族経営のドメーヌで、フォラティエールやクロ・ド・ラ・トリュフィエールなどを手がける。",
		officialWebsite: "https://www.benoitente.fr/",
	},
	"Domaine Benoît Moreau": {
		description:
			"シャサーニュ・モンラッシェを拠点とする造り手。ブノワ・モローが2020年に家族のドメーヌ・ベルナール・モローから独立して創設し、ビオディナミでシャルドネ主体の白を中心に造る。",
	},
	"Domaine Lamy-Caillat": {
		description:
			"シャサーニュ・モンラッシェを本拠に、セバスティアン・カイヤとフローランス・ラミー夫妻が営む小規模ドメーヌ。シャルドネの白のみを長期熟成・自然な造りで手掛ける。",
		officialWebsite: "http://www.lamycaillat.fr/",
	},
	"Domaine Bonneau du Martray": {
		description:
			"ペルナン・ヴェルジュレスに本拠を置くドメーヌ。コルトンの丘の特級畑のみを所有し、コルトン・シャルルマーニュ（白）とコルトン（赤）を造る。2017年よりクロエンケ家が所有。",
		officialWebsite: "https://www.bonneaudumartray.com/",
	},
	"Domaine des Croix": {
		description:
			"ボーヌを拠点とするドメーヌ。2005年にダヴィド・クロワが旧ドメーヌ・デュシェを引き継いで設立。ボーヌ1級やコルトン、コルトン・シャルルマーニュをビオロジックで造る。",
	},
	"Domaine des Comtes Lafon": {
		description:
			"ムルソーに拠点を置くラフォン家のドメーヌで、19世紀から続く家族経営。ビオディナミ栽培を行い、モンラッシェやムルソー各1級、ヴォルネの畑を所有し白ワインを中心に手がける。",
	},
	"Domaine Étienne Sauzet": {
		description:
			"ピュリニー・モンラッシェに拠点を置く白ワイン中心の家族経営ドメーヌ。エミリー＆ブノワ・リフォー夫妻が運営し、ビオディナミで白ブルゴーニュを造る。",
		officialWebsite: "https://etiennesauzet.com/",
	},
	"Domaine Leflaive": {
		description:
			"ピュリニー・モンラッシェを拠点に、シャルドネの白ワインのみを造るルフレーヴ家のドメーヌ。シュヴァリエやバタール等のグラン・クリュや複数のプルミエ・クリュを所有し、ビオディナミで栽培する。",
		officialWebsite: "https://www.leflaive.fr",
	},
	"Domaine Bruno Lorenzon": {
		description:
			"コート・シャロネーズのメルキュレイに拠点を置く家族経営ドメーヌ。3代目ブルーノ・ロレンゾンが、メルキュレイとモンタニーの1級を中心に低収量でピノ・ノワールとシャルドネを手掛ける。",
		officialWebsite: "https://www.domainelorenzon.com/",
	},
	"Domaine Jean-Marc Vincent": {
		description:
			"コート・ド・ボーヌ南部サントネーの小規模家族ドメーヌ。ジャン=マルク＆アンヌ=マリー・ヴァンサン夫妻が営み、サントネーやオーセイ・デュレスの畑を有機的に栽培する。",
	},
	"Domaine Vincent Dureuil-Janthial": {
		description:
			"コート・シャロネーズのリュリー村を本拠とする家族経営ドメーヌ。1994年よりヴァンサン・デュルイユが率い、リュリーのほかピュリニー・モンラッシェやニュイ・サン・ジョルジュも産する。",
		officialWebsite: "https://www.dureuil-janthial.fr/",
	},
	// ── MICHELIN Grapes 1グレープ（One Grape） ──
	"Domaine Armand Rousseau": {
		description:
			"ジュヴレ・シャンベルタンに拠点を置くドメーヌ。シャンベルタンやクロ・ド・ベーズなど複数のグラン・クリュを所有し、ピノ・ノワールの赤を手掛ける。現在はルソー家4代目が運営。",
		officialWebsite: "https://www.domaine-rousseau.com/",
	},
	"Domaine Denis Bachelet": {
		description:
			"ジュヴレ・シャンベルタンに拠点を置く小規模ドメーヌ。1983年からドニ・バシュレが運営し、シャルム・シャンベルタン特級など高樹齢の古木からピノ・ノワールの赤ワインを産する。",
	},
	"Domaine Claude Dugat": {
		description:
			"ジュヴレ・シャンベルタンの家族経営ドメーヌ。クロード・デュガの子ベルトラン、ラエティシア、ジャンヌが運営し、グリオットやシャルム・シャンベルタン等の銘醸を手がける。",
	},
	"Domaine Duroché": {
		description:
			"ジュヴレ・シャンベルタンの家族経営ドメーヌ。1906年創業で5代目ピエール・デュロシェが運営し、クロ・ド・ベーズやラトリシエール等のグランクリュを含むピノ・ノワールの赤を造る。",
		officialWebsite: "https://www.domaine-duroche.com/",
	},
	"Domaine Joseph Roty": {
		description:
			"ジュヴレ・シャンベルタンを拠点とする家族経営ドメーヌ。1960年代にジョゼフ・ロティが創設し、シャルム、グリオット、マジ・シャンベルタンなどのグラン・クリュと古樹由来の赤で知られる。",
	},
	"Domaine Trapet Père et Fils": {
		description:
			"ジュヴレ・シャンベルタンに拠点を置く7世代続く家族経営ドメーヌ。ジャン＝ルイ・トラペが当主で、シャンベルタンやラトリシエール等のグラン・クリュをビオディナミで栽培する。",
		officialWebsite: "https://www.domaine-trapet.fr/",
	},
	"Domaine Comte Georges de Vogüé": {
		description:
			"シャンボール・ミュジニー村に本拠を置くドメーヌ。特級ミュジニーの約7割を所有する最大の所有者で、ボンヌ・マールやレ・ザムルーズも手がける。500年以上同族が継承。",
	},
	"Domaine Ghislaine Barthod": {
		description:
			"ブルゴーニュのシャンボール・ミュジニー村に本拠を置く家族経営ドメーヌ。ジスレーヌ・バルトが当主で、村内の多数の1級畑を含むシャンボール・ミュジニーを専門とし、繊細で伝統的なピノ・ノワールを産する。",
	},
	"Domaine Hudelot-Noëllat": {
		description:
			"シャンボール・ミュジニーに本拠を置く家族経営ドメーヌ。現当主はシャルル・ヴァン・カネ。ヴォーヌ・ロマネを中心に、リシュブールやロマネ・サン・ヴィヴァンなど特級を含む赤ワインを産する。",
		officialWebsite: "https://www.domaine-hudelot-noellat.com/",
	},
	"Domaine du Clos de Tart": {
		description:
			"モレ・サン・ドニ村にあるグラン・クリュの単独所有畑（モノポール）。約7.5haの一枚畑を、現在はピノー家傘下のアルテミス・ドメーヌが所有・運営する。",
		officialWebsite: "https://www.clos-de-tart.com/",
	},
	"Domaine Louis Boillot et Fils": {
		description:
			"シャンボール・ミュジニーに本拠を置くコート・ドールの家族経営ドメーヌ。ルイ・ボワイヨが2003年に独立して設立し、ジュヴレ・シャンベルタンやヴォルネイなど各地の古樹からピノ・ノワールを造る。",
	},
	"Domaine des Lambrays": {
		description:
			"モレ・サン・ドニに本拠を置く造り手。グラン・クリュ「クロ・デ・ランブレイ」をほぼ単独所有し、ピノ・ノワール主体の赤を主力とする。2014年よりLVMH傘下。",
		officialWebsite: "https://www.lambrays.com/",
	},
	"Domaine Arnoux-Lachaux": {
		description:
			"ヴォーヌ・ロマネに本拠を置くドメーヌで、ロベール・アルヌーの家系を継ぐシャルル・ラショーが率いる。ピノ・ノワールのみを栽培し、ビオロジックと低介入の造りで知られる。",
		officialWebsite: "https://www.arnoux-lachaux.com/",
	},
	"Domaine Ponsot": {
		description:
			"モレ・サン・ドニに本拠を置く1872年創業の家族経営ドメーヌ。グラン・クリュのクロ・ド・ラ・ロッシュを筆頭に、モノポールのクロ・デ・モン・リュイザンなど銘醸畑を所有する。",
		officialWebsite: "https://domaine-ponsot.com/en/home/",
	},
	"Domaine Sylvain Cathiard": {
		description:
			"ヴォーヌ・ロマネの小規模ドメーヌ。シルヴァン・カティアールが名声を築き、現在は息子セバスティアンが運営。ロマネ・サン・ヴィヴァンやヴォーヌ・ロマネ1級アン・マルコンソールなどの赤を産する。",
	},
	"Domaine Méo-Camuzet": {
		description:
			"ヴォーヌ・ロマネに本拠を置くドメーヌ。ジャン・ニコラ・メオが率い、リシュブールやクロ・ド・ヴージョ、エシェゾーなどの特級と、クロ・パラントゥなどの1級を所有する。",
		officialWebsite: "https://www.meo-camuzet.com",
	},
	"Château de la Tour": {
		description:
			"ヴージョに拠点を置き、グラン・クリュ「クロ・ド・ヴジョ」最大の約5.5haを城壁内に所有する造り手。ラベ家が運営し、有機栽培でピノ・ノワールを手掛ける。",
	},
	"Domaine Bernard-Bonin": {
		description:
			"ムルソーを拠点とする白ワインの造り手。1998年にニコラ・ベルナールとヴェロニク・ボナン夫妻が設立し、ビオディナミでシャルドネを栽培。ムルソーとピュリニー・モンラッシェに畑を持つ。",
	},
	"Domaine Faiveley": {
		description:
			"ニュイ・サン・ジョルジュに本拠を構える1825年創業の家族経営ドメーヌ。コート・ドール〜コート・シャロネーズに約125haを所有し、メルキュレイやコルトンの単独畑で知られる。",
		officialWebsite: "https://domaine-faiveley.com/en/",
	},
	"Domaine Henri Germain et Fils": {
		description:
			"ムルソーを拠点に1973年に創設された家族経営ドメーヌ。白ワイン主体で、現当主ジャン＝フランソワ・ジェルマンがムルソーやシャサーニュ・モンラッシェの1級を手がける。",
	},
	"Domaine Henri Boillot": {
		description:
			"ムルソーに本拠を置く家族経営の造り手。プュリニー・モンラッシェの白（モノポールのクロ・ド・ラ・ムシェール等）とヴォルネイの赤で知られる。アンリとギヨーム親子が運営。",
		officialWebsite: "https://www.henri-boillot.com",
	},
	"Domaine Roulot": {
		description:
			"ムルソーを本拠とする白ワインの名門ドメーヌ。ギィ・ルーロが基礎を築き、1989年からジャン＝マルク・ルーロが継承。区画ごとの村名・プルミエクリュを緻密でミネラルなスタイルで造る。",
	},
	"Maison Vincent Girardin": {
		description:
			"1982年にヴァンサン・ジラルダンが創業した、ムルソーを拠点とするコート・ド・ボーヌのネゴシアン兼ドメーヌ。サントネー出身の家系で、白ワインを主体に幅広いアペラシオンを手がける。",
		officialWebsite: "https://www.vincentgirardin.com/",
	},
	"Domaine Marquis d'Angerville": {
		description:
			"ヴォルネイに本拠を置くダンジェルヴィル家の名門ドメーヌ。モノポールのクロ・デ・デュックなどヴォルネイ1級を中心に、ビオディナミで繊細な赤ワインを造る。",
		officialWebsite: "https://www.domainedangerville.fr/",
	},
	"Domaine de Montille": {
		description:
			"ヴォルネイに本拠を置くドメーヌ。ユベール・ド・モンティーユが礎を築き、現在は息子エティエンヌが運営。ヴォルネイやポマールの1級赤を中心に、ビオディナミで長熟型のワインを造る。",
		officialWebsite: "https://www.demontille.com/",
	},
	"Domaine Roblet-Monnot": {
		description:
			"ブルゴーニュ・ヴォルネイに拠点を置く家族経営のドメーヌ。パスカル・ロブレが率い、ヴォルネイの1級（タイユピエ、ブルイヤールなど）を中心にビオディナミで赤ワインを造る。",
	},
	"Domaine Michel Lafarge": {
		description:
			"ヴォルネイに拠点を置くドメーヌ。ラファルジュ家が営み、ビオディナミによる伝統的な赤ワイン造りで知られる。モノポールのクロ・デュ・シャトー・デ・デュックなどヴォルネイ1級を中心に手がける。",
	},
	"Maison Benjamin Leroux": {
		description:
			"元コント・アルマン醸造長のバンジャマン・ルルーが2007年にボーヌで設立したミクロ・ネゴシアン。コート・ドール全域の畑から赤白を村名からグランクリュまで少量ずつ手がける。",
		officialWebsite: "https://www.benjamin-leroux.com",
	},
	"Maison Joseph Drouhin": {
		description:
			"1880年創業、ボーヌを拠点にブルゴーニュ全域へ畑を広げる家族経営のメゾン兼ドメーヌ。ビオディナミを実践し、ボーヌ一級クロ・デ・ムーシュを代表銘柄とする。",
		officialWebsite: "https://www.drouhin.com/",
	},
	"Maison Louis Jadot": {
		description:
			"ボーヌに本拠を置く1859年創業のネゴシアン兼ドメーヌ。コート・ドールに多数の自社畑を所有し、エリティエ・ルイ・ジャドやドメーヌ・フェレを擁するブルゴーニュ大手。",
		officialWebsite: "https://www.louisjadot.com/",
	},
	"Domaine Pierre-Yves Colin-Morey": {
		description:
			"シャサーニュ・モンラッシェを拠点に、2001年にピエール=イヴ・コラン（マルク・コラン家）とカロリーヌ・モレイが設立。サン=トーバンやシャサーニュを中心に、シャルドネ主体の白ワインを手掛ける造り手。",
		officialWebsite: "https://www.colinmorey.com",
	},
	"Domaine Marc Colin et Fils": {
		description:
			"サン・トーバンを拠点とする家族経営ドメーヌ。キャロリーヌとダミアン・コラン姉弟が運営し、シャルドネ主体の白を中心にシャサーニュやモンラッシェ特級まで手がける。",
		officialWebsite: "https://www.marc-colin.com/",
	},
	"Domaine Henri & Gilles Buisson": {
		description:
			"サン・ロマン村を拠点とする家族経営のドメーヌ。ビュイッソン家が代々畑を耕し、現在はフランクとフレデリック兄弟が運営。ビオディナミを実践し、赤白双方を手がける。",
		officialWebsite: "https://www.domaine-buisson.com/",
	},
	// ── MICHELIN Grapes 選出（Selected） ──
	"Domaine Berthaut-Gerbet": {
		description:
			"フィサンに拠点を置くドメーヌ。ベルト家とジェルベ家の畑を統合し、当主アメリー・ベルトがフィサンを軸にヴォーヌ・ロマネなどコート・ド・ニュイの畑を手がける。",
		officialWebsite: "https://en.berthaut-gerbet.com/",
	},
	"Domaine Sylvain Pataille": {
		description:
			"マルサネに拠点を置く造り手。1999年にシルヴァン・パタイユが創設し、ビオディナミで栽培。マルサネの赤・白やアリゴテの多彩なキュヴェで知られる。",
	},
	"Domaine Charles Audoin": {
		description:
			"マルサネ・ラ・コート村の家族経営ドメーヌ。1972年にシャルル・オドワンが創設し、現在は息子シリルが運営。マルサネの単一区画を中心に赤・白・ロゼを手掛け、フィサンやジュヴレ・シャンベルタンも造る。",
	},
	"Domaine Felettig": {
		description:
			"コート・ド・ニュイのシャンボール・ミュジニー村に拠点を置く家族経営のドメーヌ。フェレティグ家が村名やレ・シャルム等のプルミエ・クリュを中心に、各地の畑を所有・醸造する。",
		officialWebsite: "https://www.domainefelettig.com/",
	},
	"Domaine Camille Thiriet": {
		description:
			"コート・ド・ニュイ南部コルゴロワンを拠点に、カミーユ・ティリエとマット・チティックが2016年に設立した小規模ドメーヌ。コート・ド・ニュイ・ヴィラージュを中心に区画別の醸造を手がける。",
		officialWebsite: "https://domainecamillethiriet.com/",
	},
	"Domaine Benoît Chevallier": {
		description:
			"ヴォーヌ・ロマネの小規模ドメーヌ。シュヴァリエ家が3世代所有する畑を継ぎ、ブノワ・シュヴァリエが2019年から自らの名で約4haを有機栽培で手掛ける。",
		officialWebsite: "https://en.benoitchevallier.com/",
	},
	"Domaine Fourrier": {
		description:
			"ブルゴーニュ・ジュヴレ・シャンベルタン村の老舗ドメーヌ。1990年代半ばよりジャン=マリー・フーリエが当主を務め、繊細で表現力豊かな赤ワインを産する。",
	},
	"Domaine Hubert Lignier": {
		description:
			"コート・ド・ニュイのモレ・サン・ドニを拠点とするリニエ家のドメーヌ。ピノ・ノワールによる赤を主体とし、グラン・クリュのクロ・ド・ラ・ロッシュを看板とする。",
		officialWebsite: "https://hubert-lignier.com/",
	},
	"Domaine Jobard-Morey": {
		description:
			"ムルソーに拠点を置く家族経営のドメーヌ。1949年創業で、2015年からヴァランタン・ジョバールが運営し、ムルソーの村名・1級（シャルム、ポリュゾ）を中心に白ワインを手がける。",
		officialWebsite: "https://www.jobard-morey.com/",
	},
	"Domaine Anne Boisson": {
		description:
			"ムルソーを拠点とする小規模生産者。ボワソン家のアンヌ・ボワソンが、旧ドメーヌ・ボワソン・ヴァドから継承した畑で、ムルソーを中心にシャルドネの白ワインを手掛ける。",
	},
	"Domaine Ballot-Millot": {
		description:
			"ムルソーに拠点を置く1630年以来続く家族経営ドメーヌ。現当主シャルル・バロが運営し、ムルソーの複数の一級畑を中心にピュアで均整の取れた白ワインを手がける。",
		officialWebsite: "https://domaineballotmillot.com/",
	},
	"Domaine Buisson-Charles": {
		description:
			"ムルソーに本拠を置く家族経営ドメーヌ。カトリーヌ・ビュイッソンとパトリック・エサ夫妻が営み、ムルソーの村名・プルミエクリュを中心に白ワインを手がける。",
		officialWebsite: "https://www.buisson-charles.com/",
	},
	"Domaine Camille & Guillaume Boillot": {
		description:
			"ムルソーを拠点とするコート・ド・ボーヌのドメーヌ。アンリ・ボワイヨの息子ギヨームと妻カミーユが2022年に設立し、白ワインを主体とする。",
	},
	"Domaine Pierre Boisson": {
		description:
			"ブルゴーニュ・ムルソーの家族経営ドメーヌ。旧ボワゾン=ヴァドの家系で、ベルナールの息子ピエール・ボワゾンが手がけるシャルドネ主体の白は緻密でミネラルに富む。",
	},
	"Domaine Pierre Morey": {
		description:
			"ムルソーを本拠とするドメーヌ。ビオディナミ農法で白ワインを中心に造り、ピエール・モレと娘アンヌ・モレが運営する。ムルソー・ペリエールやバタール・モンラッシェで知られる。",
		officialWebsite: "https://www.morey-meursault.fr/",
	},
	"Domaine Pierre Girardin": {
		description:
			"ムルソーに拠点を置くドメーヌ。ヴァンサン・ジラルダンの息子ピエール＝ヴァンサンが2016年に創設。コート・ド・ボーヌを中心に有機栽培で白と赤を手がける。",
	},
	"Domaine Ramonet": {
		description:
			"シャサーニュ・モンラッシェ村に本拠を置く家族経営の造り手。モンラッシェやバタール・モンラッシェなどの白グラン・クリュと、同村の一級畑の白ワインで知られる。",
	},
	"Domaine Alex Moreau": {
		description:
			"シャサーニュ・モンラッシェに本拠を置く家族経営ドメーヌ。旧ベルナール・モロー・エ・フィスを2021年に分割し、アレックス・モローが継承。シャルドネ主体の白ワインで知られる。",
	},
	"Domaine Vincent Dancer": {
		description:
			"シャサーニュ・モンラッシェに拠点を置く小規模家族経営ドメーヌ。1996年にヴァンサン・ダンセが設立し、有機栽培でピュアな白ワインを中心に手掛ける。",
	},
	"Domaine Jacques Carillon": {
		description:
			"ピュリニー・モンラッシェ村に本拠を置く白ワインの造り手。2010年の家族分割で設立され、ジャック・カリヨンとシルヴィアが率いる。端正でミネラリーなシャルドネを手掛ける。",
		officialWebsite: "https://jacques-carillon.com/en/home/",
	},
	"Domaine Thomas-Collardot": {
		description:
			"ピュリニー・モンラッシェに拠点を置く2.5haの小規模家族経営ドメーヌ。ジャクリーヌ・コラルドとその息子マチューが運営し、区画ごとに醸造する純粋で緻密な白ワインを造る。",
		officialWebsite: "https://domaine-thomas-collardot.com/",
	},
	"Maison Albert Bichot": {
		description:
			"ボーヌを拠点とする1831年創業の家族経営メゾン兼ネゴシアン。ビショ家が運営し、シャブリのロン・デパキなど6つのドメーヌを核にブルゴーニュ全域の銘柄を手がける。",
		officialWebsite: "https://www.albert-bichot.com/",
	},
	"Maison Bouchard Père & Fils": {
		description:
			"ボーヌを本拠とする1731年創業の老舗ネゴシアン兼ドメーヌ。コート・ドール最大級の畑を所有し、モンラッシェやコルトン・シャルルマーニュ等の白、ボーヌの銘醸赤を手がける。",
		officialWebsite: "https://bouchard-pereetfils.com",
	},
	"Domaine Bachelet-Monnot": {
		description:
			"マランジュ地区ドゥジズ＝レ＝マランジュに拠点を置く白ワイン主体の造り手。2005年にマルクとアレクサンドルのバシュレ兄弟が設立し、ピュリニィやバタール＝モンラッシェも手がける。",
	},
	"Domaine Nicolas Perrault": {
		description:
			"コート・ド・ボーヌ南端のドゥジズ・レ・マランジュに拠点を置く小規模家族ドメーヌ。ニコラ・ペローが2012年より率い、有機栽培でマランジュ1級やサントネイの赤白を手掛ける。",
		officialWebsite: "https://domaineperraultnicolas.fr/",
	},
	"Domaine Alain Gras": {
		description:
			"サン・ロマンを代表する家族経営の造り手。1979年からアランが手がけ、現在は息子アルチュールも参加。石灰質土壌のシャルドネとピノ・ノワールで、サン・ロマンのほかムルソーやオーセイ・デュレスも造る。",
		officialWebsite: "https://www.domaine-alain-gras.com/",
	},
	"Domaine Jean & Gilles Lafouge": {
		description:
			"オーセイ・デュレス村に17世紀から続く家族経営のドメーヌ。現在はジルと息子マキシムが赤・白を手掛け、村を代表する造り手の一つ。畑仕事や醸造は伝統的で自然な造り。",
	},
	"Domaine Joseph Colin": {
		description:
			"サン＝トーバンを拠点とするブルゴーニュの造り手。マルク・コラン家出身のジョゼフ・コランが2016年に独立して設立し、シャルドネ主体の白ワインを自然な造りで手がける。",
	},
	"Domaine Rapet Père & Fils": {
		description:
			"ペルナン・ヴェルジュレスに本拠を置く1765年創業の家族経営ドメーヌ。現当主はヴァンサン・ラペで、コルトン・シャルルマーニュやコルトンを含むテロワールを反映した赤白を手掛ける。",
		officialWebsite: "https://www.domaine-rapet.com/",
	},
	"Domaine Pierre Guillemot": {
		description:
			"サヴィニィ・レ・ボーヌに拠点を置くギユモ家の家族経営ドメーヌ。1946年創業で、ピノ・ノワール主体に村のプルミエ・クリュ数種とコルトン・グラン・クリュを手掛ける。",
	},
	"Domaine Yvon Clerget": {
		description:
			"ヴォルネーを本拠とし、1268年から続く家族経営のドメーヌ。現当主ティボー・クレルジェが運営し、ピノ・ノワールを中心にヴォルネー1級やポマール、クロ・ド・ヴジョを産する。",
		officialWebsite: "https://domaine-clerget.com/",
	},
	"Domaine Maxime Cottenceau": {
		description:
			"コート・シャロネーズのビュクシーを拠点に、2018年にマキシム・コトンソーが設立した造り手。モンタニーを中心に有機栽培のシャルドネから白ワインを手がける。",
	},
};

/** 生産者名から解説・公式サイトを引く。未登録なら undefined */
export function getProducerInfo(name: string): ProducerInfo | undefined {
	return PRODUCER_INFO[name];
}
