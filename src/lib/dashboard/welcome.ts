// 初回ログイン時のウェルカムフロー(`/welcome`)の表示判定と「見た」状態の永続化。
// DBアクセスはせず、ダッシュボードが既に持っている集計値 + 端末側の localStorage
// だけで導出する純ロジック + 小さなヘルパー。
//
// 【重要】`user` テーブルへの列追加はしない(#645 のスキーマPRと #54 の同時オープン
// 禁止のため)。「一度見たら二度と出さない」は localStorage の dismiss で持ち、
// 初回かどうかの判定は `mastery.seen === 0 && cellar.totalCount === 0` で代用する
// (#206)。user テーブルへの永続化は #645 マージ後のフォローアップで行う。

import type { StarterInput } from "./onboarding";

const WELCOME_DISMISSED_KEY = "welcome-dismissed";

/**
 * 初回とみなすか。クイズを1問も解いておらず、マイセラーにも何も登録していない
 * 状態を「まだ何もしていない = サインアップ直後のはず」とみなす。
 * スキーマを足さない代替案のため、サインアップ直後に離脱したユーザには
 * 再訪時にも出る(許容する)。
 */
export function isFirstTimeVisitor(input: StarterInput): boolean {
	return input.seen === 0 && input.cellarTotalCount === 0;
}

/** `/` から `/welcome` へ誘導するか。見終わった(スキップ含む)ら出さない。 */
export function shouldRedirectToWelcome(
	input: StarterInput & { welcomeDismissed: boolean },
): boolean {
	if (input.welcomeDismissed) return false;
	return isFirstTimeVisitor(input);
}

/**
 * ウェルカムを見終わったか(端末側)。SSR 時は window が無いので false
 * (SSR と初回クライアント描画を一致させ、ハイドレーションミスマッチを避ける)。
 * プライベートモード等で localStorage が使えなければ未表示扱い。
 */
export function isWelcomeDismissed(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(WELCOME_DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** ウェルカムの完了・スキップを端末に記録する。 */
export function dismissWelcome(): void {
	try {
		window.localStorage.setItem(WELCOME_DISMISSED_KEY, "1");
	} catch {
		// localStorage が使えなくても、このセッションで誘導が止まれば十分
	}
}
