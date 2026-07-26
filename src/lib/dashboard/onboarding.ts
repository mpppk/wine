import { STARTER_GUIDE_GRADUATION_SEEN } from "./constants";

// 新規ユーザ向けスターターガイド(「おすすめの使い方」3ステップ)の表示判定。
// DBアクセスはせず、ダッシュボードが既に持っている集計値だけで導出する純ロジック。

export type StarterStepId = "map" | "quiz" | "cellar";

export interface StarterStep {
	id: StarterStepId;
	/**
	 * 完了したか。`null` は「完了を判定できないステップ」。
	 * 地図の閲覧はサーバに記録が無い(daily_activity はクイズの解答数しか持たない)ため
	 * map は常に null で、チェックを付けずに導線だけを出す。
	 */
	done: boolean | null;
}

/** ガイドの表示判定・ステップ構築が必要とする集計値(DashboardData から渡す) */
export interface StarterInput {
	/** 一度でも解いた問題数(DashboardData.mastery.seen) */
	seen: number;
	/**
	 * マイセラーの登録総数(DashboardData.cellar.totalCount)。飲んだ本数
	 * (tastedCount)ではなく総数を見る: セラーのステップは「マイセラーを使い始めた」
	 * ことの確認なので、「気になる」「セラーにある」での登録でも完了とする(#200)。
	 */
	cellarTotalCount: number;
}

/**
 * 3ステップを「地図で眺める → クイズで覚える → 飲んだワインを記録する」の順で返す。
 * 順序はアプリのおすすめの使い方そのものなので固定する。
 */
export function buildStarterSteps({
	seen,
	cellarTotalCount,
}: StarterInput): StarterStep[] {
	return [
		{ id: "map", done: null },
		{ id: "quiz", done: seen > 0 },
		{ id: "cellar", done: cellarTotalCount > 0 },
	];
}

/**
 * ガイドを出すか。判定可能なステップが全て完了したら出さない。
 * 加えて、既に使い込んでいるユーザ(解答数が卒業ラインを超えている)には
 * 未完了のステップが残っていても出さない。
 *
 * なお「閉じる」による非表示はユーザ端末側(localStorage)の状態なのでここでは扱わない。
 */
export function shouldShowStarterGuide(input: StarterInput): boolean {
	if (input.seen >= STARTER_GUIDE_GRADUATION_SEEN) return false;
	return buildStarterSteps(input).some((step) => step.done === false);
}
