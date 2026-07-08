import type { RegionId } from "#/lib/wine/types";

// クイズ形式のレジストリ(真実の源)。UIの形式選択・server fnの入力検証・
// 進捗ページの集計軸がこのIDを共有する。
export const QUIZ_TYPES = [
	{ id: "colors", labelJa: "生産可能色" },
	{ id: "odd-one-out", labelJa: "仲間外れ" },
	{ id: "variety", labelJa: "品種フォーカス" },
	{ id: "location", labelJa: "位置関係" },
] as const;

export type QuizType = (typeof QUIZ_TYPES)[number]["id"];

export const QUIZ_TYPE_IDS = QUIZ_TYPES.map((t) => t.id) as [
	QuizType,
	...QuizType[],
];

export const QUIZ_TYPE_LABELS_JA: Record<QuizType, string> = Object.fromEntries(
	QUIZ_TYPES.map((t) => [t.id, t.labelJa]),
) as Record<QuizType, string>;

export interface QuizOption {
	/** 回答判定に使う選択肢ID(AOP選択肢は aopId、色コンボは "red+white" 等) */
	id: string;
	label: string;
	/** 補助表示(AOP選択肢の原語名など) */
	labelSub?: string;
}

/**
 * 具現化された1問。サーバが正解・解説込みで返し、クライアントは回答直後に
 * 即時フィードバックを表示する(学習アプリなのでアンチチートは不要)。
 */
export interface QuizQuestion {
	/** 「テストされる事実」を表す安定キー。成績はこの単位で集計する */
	key: string;
	quizType: QuizType;
	regionId: RegionId;
	prompt: string;
	/** 4択・シャッフル済み */
	options: QuizOption[];
	correctOptionId: string;
	/** 回答後に表示する解説 */
	explanation: string;
	/** 出題対象(正解)のAOP。バッチ内の重複抑制にも使う */
	subjectAopId: string;
}
