import type { Aop, AopProducer } from "./types";

// 生産者の購入リンク(アフィリエイト)生成。生産者名からECサイトの検索結果URLを
// 自動生成し、アフィリエイトIDが設定されていれば計測用URLでラップする。
// UI(AopDetailPanel)とMCP(get_aop)の両方から使う。
//
// このモジュールはクライアント(AopDetailPanel)からも読み込まれるため、
// cloudflare:workers の env を直接参照しない。アフィリエイトIDは呼び出し側が
// AffiliateConfig として渡す(サーバーは env から読み、UIは server fn 経由で受け取る)。

/**
 * アフィリエイトID。リンクURLに含まれる公開情報だが、環境ごとに切り替えられる
 * よう環境変数から供給する。未設定(空)なら素の検索URLを返す(リンクは機能する)。
 */
export interface AffiliateConfig {
	/** 楽天アフィリエイトID (例: "0a1b2c3d.e4f5a6b7.0a1b2c3d.e4f5a6b8") */
	rakuten?: string;
	/** もしもアフィリエイトの a_id (Amazon.co.jp プロモーションの広告枠ID) */
	moshimoAmazon?: string;
}

/** ID未設定の既定値。この状態でも素の検索リンクとして機能する */
export const EMPTY_AFFILIATE_CONFIG: AffiliateConfig = {};

/** 楽天市場のジャンルID「ワイン」。検索結果をワインに限定する */
const RAKUTEN_WINE_GENRE_ID = "510915";

// もしもアフィリエイト経由 Amazon.co.jp の固定パラメータ(a_id のみユーザー固有)
const MOSHIMO_AMAZON_PARAMS = "p_id=170&pc_id=185&pl_id=4062";

/**
 * 欧文表記の生産者名 → 日本のECでヒットしやすいカタカナ検索語の共通辞書。
 * 同じ生産者が複数のAOPに登場するため、aops.json 側ではなくここで一元管理する。
 * aops.json の searchKeyword が指定されていればそちらが優先される。
 */
const PRODUCER_SEARCH_KEYWORDS: Record<string, string> = {
	// ブルゴーニュ / ボージョレ
	"Domaine Leflaive": "ドメーヌ・ルフレーヴ",
	"Maison Olivier Leflaive": "オリヴィエ・ルフレーヴ",
	"Domaine Ramonet": "ドメーヌ・ラモネ",
	"Domaine de la Romanée-Conti": "ロマネ・コンティ",
	"Domaine Leroy": "ドメーヌ・ルロワ",
	"Domaine d'Auvenay": "ドーヴネ",
	"Domaine Coche-Dury": "コシュ・デュリ",
	"Domaine Georges Roumier": "ジョルジュ・ルーミエ",
	"Domaine Dugat-Py": "デュガ・ピィ",
	"Domaine Cécile Tremblay": "セシル・トランブレイ",
	"Domaine Jean-Marc & Thomas Bouley": "ジャン・マルク・ブーレイ",
	"Domaine Hubert Lamy": "ユベール・ラミー",
	"Maison Louis Jadot": "ルイ・ジャド",
	"Maison Louis Latour": "ルイ・ラトゥール",
	"Maison Joseph Drouhin": "ジョゼフ・ドルーアン",
	"Maison Albert Bichot": "アルベール・ビショー",
	"Georges Duboeuf": "ジョルジュ・デュブッフ",
	// シャンパーニュ
	"Moët & Chandon": "モエ・エ・シャンドン",
	"Veuve Clicquot": "ヴーヴ・クリコ",
	Bollinger: "ボランジェ",
	Taittinger: "テタンジェ",
	Pommery: "ポメリー",
	"Louis Roederer": "ルイ・ロデレール",
	"Laurent-Perrier": "ローラン・ペリエ",
	Ruinart: "ルイナール",
	"Nicolas Feuillatte": "ニコラ・フィアット",
	"Jacques Selosse": "ジャック・セロス",
	Salon: "サロン シャンパーニュ",
	"Krug (Clos d'Ambonnay)": "クリュッグ",
	"Krug (Clos du Mesnil)": "クリュッグ クロ・デュ・メニル",
	Deutz: "ドゥーツ",
	Gosset: "ゴッセ",
	"Billecart-Salmon": "ビルカール・サルモン",
	"Philipponnat (Clos des Goisses)": "フィリポナ",
	// ボルドー(村名AOCの代表生産者として登場するシャトー)
	Pétrus: "ペトリュス",
	"Château d'Yquem": "シャトー・ディケム",
	"Château Margaux": "シャトー・マルゴー",
	"Château Palmer": "シャトー・パルメ",
	"Château Figeac": "シャトー・フィジャック",
	"Château Angélus": "シャトー・アンジェリュス",
	"Château Pavie": "シャトー・パヴィ",
	"Vieux Château Certan": "ヴィユー・シャトー・セルタン",
	// MICHELIN Grapes 2/1/選出（2026 追加）
	"Domaine Denis Mortet": "ドニ・モルテ",
	"Domaine Dujac": "ドメーヌ・デュジャック",
	"Domaine Georges Mugneret-Gibourg": "ミュニュレ・ジブール",
	"Domaine Bruno Clair": "ブリュノ・クレール",
	"Domaine Gérard Mugneret": "ジェラール・ミュニュレ",
	"Domaine Jacques-Frédéric Mugnier": "ミュニエ",
	"Domaine Paul Pillot": "ポール・ピヨ",
	"Domaine Arnaud Ente": "アルノー・アント",
	"Domaine Jean-Claude Bachelet et Fils": "ジャン・クロード・バシュレ",
	"Domaine Benoît Ente": "ブノワ・アンテ",
	"Domaine Benoît Moreau": "ブノワ・モロー",
	"Domaine Lamy-Caillat": "ラミ・カイヤ",
	"Domaine Bonneau du Martray": "ボノー・デュ・マルトレイ",
	"Domaine des Croix": "ドメーヌ・デ・クロワ",
	"Domaine des Comtes Lafon": "コント・ラフォン",
	"Domaine Étienne Sauzet": "エティエンヌ・ソゼ",
	"Domaine Bruno Lorenzon": "ブルーノ・ロレンゾン",
	"Domaine Jean-Marc Vincent": "ジャン・マルク・ヴァンサン",
	"Domaine Vincent Dureuil-Janthial": "デュルイユ・ジャンティアル",
	"Domaine Armand Rousseau": "アルマン・ルソー",
	"Domaine Denis Bachelet": "ドニ・バシュレ",
	"Domaine Claude Dugat": "クロード・デュガ",
	"Domaine Duroché": "デュロシェ",
	"Domaine Joseph Roty": "ジョセフ・ロティ",
	"Domaine Trapet Père et Fils": "ドメーヌ・トラペ",
	"Domaine Comte Georges de Vogüé": "コント・ジョルジュ・ド・ヴォギュエ",
	"Domaine Ghislaine Barthod": "ジスレーヌ・バルト",
	"Domaine Hudelot-Noëllat": "ユドロ・ノエラ",
	"Domaine du Clos de Tart": "クロ・ド・タール",
	"Domaine Louis Boillot et Fils": "ルイ・ボワイヨ",
	"Domaine des Lambrays": "ドメーヌ・デ・ランブレイ",
	"Domaine Arnoux-Lachaux": "アルヌー・ラショー",
	"Domaine Ponsot": "ドメーヌ・ポンソ",
	"Domaine Sylvain Cathiard": "シルヴァン・カティアール",
	"Domaine Méo-Camuzet": "メオ・カミュゼ",
	"Château de la Tour": "シャトー・ド・ラ・トゥール",
	"Domaine Bernard-Bonin": "ベルナール・ボナン",
	"Domaine Faiveley": "フェヴレ",
	"Domaine Henri Germain et Fils": "アンリ・ジェルマン",
	"Domaine Henri Boillot": "アンリ・ボワイヨ",
	"Domaine Roulot": "ドメーヌ・ルーロ",
	"Maison Vincent Girardin": "ヴァンサン・ジラルダン",
	"Domaine Marquis d'Angerville": "マルキ・ダンジェルヴィル",
	"Domaine de Montille": "ドメーヌ・ド・モンティーユ",
	"Domaine Roblet-Monnot": "ロブレ・モノ",
	"Domaine Michel Lafarge": "ミシェル・ラファルジュ",
	"Maison Benjamin Leroux": "バンジャマン・ルルー",
	"Domaine Pierre-Yves Colin-Morey": "ピエール・イヴ・コラン・モレイ",
	"Domaine Marc Colin et Fils": "マルク・コラン",
	"Domaine Henri & Gilles Buisson": "アンリ・エ・ジル・ビュイッソン",
	"Domaine Berthaut-Gerbet": "ベルトー・ジェルベ",
	"Domaine Sylvain Pataille": "シルヴァン・パタイユ",
	"Domaine Charles Audoin": "シャルル・オドワン",
	"Domaine Felettig": "フェレティグ",
	"Domaine Camille Thiriet": "カミーユ・ティリエ",
	"Domaine Benoît Chevallier": "ブノワ・シュヴァリエ",
	"Domaine Fourrier": "ドメーヌ・フーリエ",
	"Domaine Hubert Lignier": "ユベール・リニエ",
	"Domaine Jobard-Morey": "ジョバール・モレ",
	"Domaine Anne Boisson": "アンヌ・ボワソン",
	"Domaine Ballot-Millot": "バロ・ミロ",
	"Domaine Buisson-Charles": "ビュイッソン・シャルル",
	"Domaine Camille & Guillaume Boillot": "カミーユ・エ・ギヨーム・ボワイヨ",
	"Domaine Pierre Boisson": "ピエール・ボワゾン",
	"Domaine Pierre Morey": "ピエール・モレ",
	"Domaine Pierre Girardin": "ピエール・ジラルダン",
	"Domaine Alex Moreau": "アレックス・モロー",
	"Domaine Vincent Dancer": "ヴァンサン・ダンセ",
	"Domaine Jacques Carillon": "ジャック・カリヨン",
	"Domaine Thomas-Collardot": "トマ・コラルド",
	"Maison Bouchard Père & Fils": "ブーシャール・ペール・エ・フィス",
	"Domaine Bachelet-Monnot": "バシュレ・モノ",
	"Domaine Nicolas Perrault": "ニコラ・ペロー",
	"Domaine Alain Gras": "アラン・グラ",
	"Domaine Jean & Gilles Lafouge": "ラフージュ",
	"Domaine Joseph Colin": "ジョセフ・コラン",
	"Domaine Rapet Père & Fils": "ドメーヌ・ラペ",
	"Domaine Pierre Guillemot": "ピエール・ギユモ",
	"Domaine Yvon Clerget": "イヴォン・クレルジェ",
	"Domaine Maxime Cottenceau": "マキシム・コトンソー",
	// ピエモンテ
	Accornero: "アッコルネロ",
	"Angelo Negro": "アンジェロ・ネグロ",
	"Antichi Vigneti di Cantalupo":
		"アンティキ・ヴィニェティ・ディ・カンタルーポ",
	Antoniolo: "アントニオロ",
	"Bartolo Mascarello": "バルトロ・マスカレッロ",
	Bava: "バーヴァ",
	Bersano: "ベルサーノ",
	Braida: "ブライダ",
	Broglia: "ブロリア",
	"Bruno Giacosa": "ブルーノ・ジャコーザ",
	"Bruno Rocca": "ブルーノ・ロッカ",
	"Ca' del Baio": "カ・デル・バイオ",
	"Cascina Bruciata": "カッシーナ・ブルチャータ",
	"Cascina delle Rose": "カッシーナ・デッレ・ローゼ",
	"Castellari Bergaglio": "カステッラーリ・ベルガリオ",
	"Castello di Verduno": "カステッロ・ディ・ヴェルドゥーノ",
	Cavallotto: "カヴァロット",
	Ceretto: "チェレット",
	Chionetti: "キオネッティ",
	Cieck: "チエック",
	"Claudio Alario": "クラウディオ・アラリオ",
	"Claudio Mariotto": "クラウディオ・マリオット",
	"Colombera & Garella": "コロンベーラ・エ・ガレッラ",
	Coppo: "コッポ",
	"Domenico Clerico": "ドメニコ・クレリコ",
	"Elio Grasso": "エリオ・グラッソ",
	"Enrico Serafino": "エンリコ・セラフィーノ",
	"Ettore Germano": "エットーレ・ジェルマーノ",
	Ferrando: "フェランド",
	"Ferraris Agricola": "フェラーリス・アグリコラ",
	Fontanafredda: "フォンタナフレッダ",
	"Fratelli Alessandria": "フラテッリ・アレッサンドリア",
	"G.B. Burlotto": "ブルロット",
	"G.D. Vajra": "ヴァイラ",
	Gaja: "ガヤ",
	"Giacomo Conterno": "ジャコモ・コンテルノ",
	"La Gironda": "ラ・ジロンダ",
	"La Guardia": "ラ・グアルディア",
	"La Scolca": "ラ・スコルカ",
	"La Spinetta": "ラ・スピネッタ",
	"Luciano Sandrone": "ルチアーノ・サンドローネ",
	"Luigi Spertino": "ルイジ・スペルティーノ",
	Malvirà: "マルヴィラ",
	Marcarini: "マルカリーニ",
	Marenco: "マレンコ",
	"Marziano Abbona": "マルツィアーノ・アッボーナ",
	Massolino: "マッソリーノ",
	"Matteo Correggia": "マッテオ・コレッジア",
	"Michele Chiarlo": "ミケーレ・キアルロ",
	"Monchiero Carbone": "モンキエロ・カルボーネ",
	Montalbera: "モンタルベーラ",
	"Nervi-Conterno": "ネルヴィ・コンテルノ",
	"Nicola Bergaglio": "ニコラ・ベルガリオ",
	"Odilio Antoniotti": "オディリオ・アントニオッティ",
	Orsolani: "オルソラーニ",
	"Paolo Saracco": "パオロ・サラッコ",
	"Paolo Scavino": "パオロ・スカヴィーノ",
	Pecchenino: "ペッケニーノ",
	Pescaja: "ペスカイア",
	"Pico Maccario": "ピコ・マッカリオ",
	"Pio Cesare": "ピオ・チェザーレ",
	"Poderi Aldo Conterno": "アルド・コンテルノ",
	"Produttori del Barbaresco": "プロドゥットーリ・デル・バルバレスコ",
	"Proprietà Sperino": "プロプリエタ・スペリーノ",
	Roagna: "ロアーニャ",
	"Roberto Voerzio": "ロベルト・ヴォエルツィオ",
	Rovellotti: "ロヴェロッティ",
	"San Fereolo": "サン・フェレオロ",
	Sella: "セッラ",
	Sottimano: "ソッティマーノ",
	Tacchino: "タッキーノ",
	"Tenuta La Tenaglia": "テヌータ・ラ・テナリア",
	"Tenuta Tamburnin": "テヌータ・タンブルニン",
	"Torraccia del Piantavigna": "トッラッチャ・デル・ピアンタヴィーニャ",
	Travaglini: "トラヴァリーニ",
	Vietti: "ヴィエッティ",
	"Vigneti Massa": "ヴィニェティ・マッサ",
	"Villa Sparina": "ヴィッラ・スパリーナ",
	// トスカーナ
	Acquabona: "アクアボーナ",
	Argentiera: "アルジェンティエラ",
	Avignonesi: "アヴィニョネージ",
	"Badia a Coltibuono": "バディア・ア・コルティブオーノ",
	Banfi: "バンフィ",
	"Barone Ricasoli": "バローネ・リカーゾリ",
	"Biondi-Santi": "ビオンディ・サンティ",
	Boscarelli: "ボスカレッリ",
	Bruni: "ブルーニ",
	"Canalicchio di Sopra": "カナリッキオ・ディ・ソプラ",
	Capitoni: "カピトーニ",
	Carmignani: "カルミニャーニ",
	"Casanova di Neri": "カサノヴァ・ディ・ネリ",
	"Castello Banfi": "カステッロ・バンフィ",
	"Castello di Ama": "カステッロ・ディ・アマ",
	"Castello di Monsanto": "カステッロ・ディ・モンサント",
	"Castello di Volpaia": "カステッロ・ディ・ヴォルパイア",
	Cecilia: "チェチリア",
	Cerbaiona: "チェルバイオーナ",
	Cima: "チーマ",
	"Col d'Orcia": "コル・ドルチャ",
	ColleMassari: "コッレマッサーリ",
	Costanti: "コスタンティ",
	"Donatella Cinelli Colombini": "ドナテッラ・チネッリ・コロンビーニ",
	"Fattoria Ambra": "ファットリア・アンブラ",
	"Fattoria Le Pupille": "ファットリア・レ・プピッレ",
	"Fattoria del Buonamico": "ファットリア・デル・ブオナミーコ",
	"Fattoria di Fubbiano": "ファットリア・ディ・フッビアーノ",
	Fontodi: "フォントディ",
	Frescobaldi: "フレスコバルディ",
	Fuligni: "フリーニ",
	Fèlsina: "フェルシナ",
	Grattamacco: "グラッタマッコ",
	"Guado al Tasso": "グアド・アル・タッソ",
	"Gualdo del Re": "グアルド・デル・レ",
	"Il Colombaio di Santa Chiara": "イル・コロンバイオ・ディ・サンタ・キアラ",
	"Il Poggione": "イル・ポッジョーネ",
	"Isole e Olena": "イゾレ・エ・オレーナ",
	"Jacopo Banti": "ヤコポ・バンティ",
	"Le Macchiole": "レ・マッキオーレ",
	Lisini: "リジーニ",
	"Marchesi Antinori": "アンティノリ",
	"Michele Satta": "ミケーレ・サッタ",
	Montenidoli: "モンテニドリ",
	Ornellaia: "オルネライア",
	Panizzi: "パニッツィ",
	Petra: "ペトラ",
	Piaggia: "ピアッジャ",
	"Podere Sapaio": "ポデーレ・サパイオ",
	"Podere Scurtarola": "ポデーレ・スクルタローラ",
	"Poggio Argentiera": "ポッジョ・アルジェンティエラ",
	"Poggio di Sotto": "ポッジョ・ディ・ソット",
	Poliziano: "ポリツィアーノ",
	Querciabella: "クエルチャベッラ",
	Riecine: "リエチーネ",
	"Rocca delle Macìe": "ロッカ・デッレ・マチエ",
	"Rocca di Frassinello": "ロッカ・ディ・フラッシネッロ",
	Ruffino: "ルフィーノ",
	Salustri: "サルストリ",
	Salvioni: "サルヴィオーニ",
	"San Felice": "サン・フェリーチェ",
	"San Giusto a Rentennano": "サン・ジュスト・ア・レンテンナーノ",
	"Siro Pacenti": "シーロ・パチェンティ",
	Soldera: "ソルデラ",
	"Stefano Amerighi": "ステファノ・アメリギ",
	"Tenimenti Luigi d'Alessandro": "テニメンティ・ルイジ・ダレッサンドロ",
	"Tenuta San Guido": "テヌータ・サン・グイド",
	"Tenuta di Artimino": "テヌータ・ディ・アルティミーノ",
	"Tenuta di Capezzana": "テヌータ・ディ・カペッツァーナ",
	"Tenuta di Valgiano": "テヌータ・ディ・ヴァルジャーノ",
	Teruzzi: "テルッツィ",
	"Tua Rita": "トゥア・リータ",
	Valdicava: "ヴァルディカーヴァ",
};

export interface PurchaseLinks {
	rakuten: string;
	amazon: string;
}

/**
 * 「ジロンド県内の多数の生産者」のような、実在の単一生産者を指さない
 * プレースホルダー表記はリンク対象外にする。
 */
export function isLinkableProducerName(name: string): boolean {
	return name !== "-" && !name.includes("多数の");
}

/** 楽天市場のワインジャンル内検索URL。IDが設定されていればアフィリエイトリンクでラップ */
export function buildRakutenSearchUrl(
	keyword: string,
	affiliateId = "",
): string {
	const searchUrl = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/${RAKUTEN_WINE_GENRE_ID}/`;
	if (!affiliateId) return searchUrl;
	const encoded = encodeURIComponent(searchUrl);
	return `https://hb.afl.rakuten.co.jp/hgc/${affiliateId}/?pc=${encoded}&m=${encoded}`;
}

/** Amazon.co.jp の検索URL。IDが設定されていればもしもアフィリエイト経由でラップ */
export function buildAmazonSearchUrl(keyword: string, moshimoAId = ""): string {
	const searchUrl = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}`;
	if (!moshimoAId) return searchUrl;
	return `https://af.moshimo.com/af/c/click?a_id=${moshimoAId}&${MOSHIMO_AMAZON_PARAMS}&url=${encodeURIComponent(searchUrl)}`;
}

/**
 * 生産者1件分の購入リンク。手動リンク(links)があればそれを優先し、
 * なければ searchKeyword → 共通辞書 → name の順のキーワードで検索リンクを生成する。
 * プレースホルダー表記の生産者には null を返す。
 * winery(シャトー)の producers は所有者/運営体なので、呼び出し側でリンクを
 * 出さない判断をすること(代わりに getWineryPurchaseLinks を使う)。
 */
export function getProducerPurchaseLinks(
	producer: AopProducer,
	config: AffiliateConfig = EMPTY_AFFILIATE_CONFIG,
): PurchaseLinks | null {
	if (!isLinkableProducerName(producer.name)) return null;
	const keyword =
		producer.searchKeyword ??
		PRODUCER_SEARCH_KEYWORDS[producer.name] ??
		producer.name;
	return {
		rakuten:
			producer.links?.rakuten ?? buildRakutenSearchUrl(keyword, config.rakuten),
		amazon:
			producer.links?.amazon ??
			buildAmazonSearchUrl(keyword, config.moshimoAmazon),
	};
}

/**
 * winery(ボルドーのシャトー等)はAOPエントリ自体が生産者なので、
 * シャトー名(nameJa)で検索する購入リンクを返す。winery 以外は null。
 */
export function getWineryPurchaseLinks(
	aop: Aop,
	config: AffiliateConfig = EMPTY_AFFILIATE_CONFIG,
): PurchaseLinks | null {
	if (aop.kind !== "winery") return null;
	return {
		rakuten: buildRakutenSearchUrl(aop.nameJa, config.rakuten),
		amazon: buildAmazonSearchUrl(aop.nameJa, config.moshimoAmazon),
	};
}
