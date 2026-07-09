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
