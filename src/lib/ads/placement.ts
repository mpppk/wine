// 広告の「配置」ルール(どこに・どの頻度で出すか)。DBアクセスを持たない純粋関数。
// 「このユーザーに広告を出してよいか」は billing/entitlements の shouldShowAds が担い、
// ここではページ・タイミングの判定のみを行う。

/** 下部固定バナーを出す学習系ページ(前方一致で判定するprefix)。 */
const BANNER_PATH_PREFIXES = ["/map/", "/quiz", "/cellar"] as const;

/**
 * 下部固定バナーの対象ページか判定する。
 * - 対象: 地図(/map/$regionId)・クイズ(/quiz, /quiz/progress)・セラー(/cellar配下)
 * - 例外: /quiz/play は画面下部にsticky操作バー(スキップ/次へ)があり誤タップを
 *   誘発するため出さない(クイズ中は10問ごとのインタースティシャルのみ)
 */
export function isAdBannerPath(pathname: string): boolean {
	if (pathname === "/quiz/play" || pathname.startsWith("/quiz/play/")) {
		return false;
	}
	return BANNER_PATH_PREFIXES.some(
		(prefix) =>
			pathname === prefix ||
			pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
	);
}

/** クイズでインタースティシャル広告を挟む回答数の間隔。 */
export const QUIZ_AD_INTERVAL = 10;

/**
 * クイズの「次へ」でインタースティシャル広告を挟むべきか判定する。
 * answered はその時点の累計回答数(スキップは含まない)。10問目・20問目…の
 * フィードバックから次の問題へ進む瞬間に true になる。
 */
export function shouldShowQuizAd(answered: number): boolean {
	return answered > 0 && answered % QUIZ_AD_INTERVAL === 0;
}
