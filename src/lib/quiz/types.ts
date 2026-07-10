import type { RegionId } from "#/lib/wine/types";

// クイズ形式のレジストリ(真実の源)。UIの形式選択・server fnの入力検証・
// 進捗ページの集計軸がこのIDを共有する。
// answerIsAop: 正解の選択肢が対象AOP自身か(＝設問文に対象AOP名が現れない形式か)。
// colors は設問文に対象AOP名が出て正解は「色」なので false。
export const QUIZ_TYPES = [
	{ id: "colors", labelJa: "生産可能色", answerIsAop: false },
	{ id: "odd-one-out", labelJa: "仲間外れ", answerIsAop: true },
	{ id: "variety", labelJa: "品種フォーカス", answerIsAop: true },
	{ id: "location", labelJa: "位置関係", answerIsAop: true },
] as const;

export type QuizType = (typeof QUIZ_TYPES)[number]["id"];

export const QUIZ_TYPE_IDS = QUIZ_TYPES.map((t) => t.id) as [
	QuizType,
	...QuizType[],
];

/** 正解の選択肢が対象AOP自身になる形式。関連クイズで「対象＝正解」の自明問題を弾くのに使う */
export const AOP_ANSWER_QUIZ_TYPES: ReadonlySet<QuizType> = new Set(
	QUIZ_TYPES.filter((t) => t.answerIsAop).map((t) => t.id),
);

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
