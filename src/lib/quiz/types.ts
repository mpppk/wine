import type { RegionId } from "#/lib/wine/types";

// クイズ形式のレジストリ(真実の源)。UIの形式選択・server fnの入力検証・
// 進捗ページの集計軸がこのIDを共有する。
// answerIsAop: 正解の選択肢が対象AOP自身か(＝設問文に対象AOP名が現れない形式か)。
//  - false: 設問文の主語が対象AOPで、正解はそのAOPの属性(色・品種・地区・格付け)。
//    地図の「関連クイズ」はこの形式だけを出す(問題文そのものがそのAOPに関する設問)。
//  - true : 設問文の主語は軸(色/品種/地区/方角)で、対象AOPは4択の正解にすぎない。
//    たまたま正解が近傍AOPになるだけなので、関連クイズには出さず地域全体クイズ専用。
export const QUIZ_TYPES = [
	{ id: "colors", labelJa: "生産可能色", answerIsAop: false },
	{ id: "aop-variety", labelJa: "主要品種", answerIsAop: false },
	{ id: "aop-subregion", labelJa: "所属地区", answerIsAop: false },
	{ id: "aop-classification", labelJa: "格付け", answerIsAop: false },
	{ id: "grand-cru-select", labelJa: "特級を選ぶ", answerIsAop: true },
	{ id: "grand-cru-odd", labelJa: "特級の仲間外れ", answerIsAop: true },
	{ id: "odd-one-out", labelJa: "仲間外れ", answerIsAop: true },
	{ id: "variety", labelJa: "品種フォーカス", answerIsAop: true },
	{ id: "location", labelJa: "位置関係", answerIsAop: true },
] as const;

export type QuizType = (typeof QUIZ_TYPES)[number]["id"];

export const QUIZ_TYPE_IDS = QUIZ_TYPES.map((t) => t.id) as [
	QuizType,
	...QuizType[],
];

/** 正解の選択肢が対象AOP自身になる形式。関連クイズ(問題文の主語がAOPの形式のみ)から弾くのに使う */
export const AOP_ANSWER_QUIZ_TYPES: ReadonlySet<QuizType> = new Set(
	QUIZ_TYPES.filter((t) => t.answerIsAop).map((t) => t.id),
);

/**
 * 地図の「関連クイズ」(選択AOPスコープ)から除外する形式(#485)。
 * グラン・クリュ形式(grand-cru-select/grand-cru-odd)は正解が対象AOP自身で
 * 「その畑が特級か」を問うため、たまたま正解が近傍AOPになるだけの
 * odd-one-out/variety/location とは異なりスコープに含める。
 * ヴォーヌ=ロマネの各グラン・クリュは色・品種・地区が村と完全一致するため
 * 主語形式だけでは村の3問に潰れ、各畑を開くたび同じ3問が出続けていた。
 * 特級形式を含めることで各畑が固有の1問(grand-cru-select:{畑})を持ち、
 * スコープ間で設問が変わる。
 * 進捗の分母(candidateCountsByAopId)・分子(getAopSolvedProgress)も
 * この定義に揃える(3箇所が食い違うとパネルの問題数と進捗の分母がずれる)。
 */
export const OUT_OF_SCOPE_QUIZ_TYPES: ReadonlySet<QuizType> = new Set([
	"odd-one-out",
	"variety",
	"location",
]);

export const QUIZ_TYPE_LABELS_JA: Record<QuizType, string> = Object.fromEntries(
	QUIZ_TYPES.map((t) => [t.id, t.labelJa]),
) as Record<QuizType, string>;

interface QuizOption {
	/** 回答判定に使う選択肢ID(AOP選択肢は aopId、色コンボは "red+white" 等) */
	id: string;
	label: string;
	/** 補助表示(AOP選択肢の原語名など) */
	labelSub?: string;
}

/**
 * 具現化された1問。サーバが正解・解説込みで返し、クライアントは回答直後に
 * 即時フィードバックを表示する(学習アプリなのでアンチチートは不要)。
 *
 * selectionKind で回答形式を表す。
 * - "single": 4択から1つを選ぶ。correctOptionIds は [correctOptionId] と等しい。
 * - "multi": 候補一覧から該当するものをすべて選ぶ(複数選択)。正誤は
 *   correctOptionIds との完全一致でのみ判定する(部分点なし)。
 * correctOptionId は正解の正規コンボID(互換・ログ用)。multi でも
 * correctOptionIds の正規結合を保持する。
 */
export interface QuizQuestion {
	/** 「テストされる事実」を表す安定キー。成績はこの単位で集計する */
	key: string;
	quizType: QuizType;
	regionId: RegionId;
	prompt: string;
	/** singleでは4択・シャッフル済み、multiでは候補一覧・シャッフル済み */
	options: QuizOption[];
	correctOptionId: string;
	/** 回答形式 */
	selectionKind: "single" | "multi";
	/** 正解の選択肢ID集合。singleでは [correctOptionId] */
	correctOptionIds: string[];
	/** 回答後に表示する解説 */
	explanation: string;
	/** 出題対象(正解)のAOP。バッチ内の重複抑制にも使う */
	subjectAopId: string;
}

/**
 * 複数選択の正誤判定。正解集合との完全一致(順序不問・重複無視)でのみ
 * 正解とする。single形式の1択回答にもそのまま使える。
 */
export function isSelectionCorrect(
	question: QuizQuestion,
	selectedIds: readonly string[],
): boolean {
	const correct = new Set(question.correctOptionIds);
	if (selectedIds.length !== correct.size) return false;
	const seen = new Set<string>();
	for (const id of selectedIds) {
		if (!correct.has(id) || seen.has(id)) return false;
		seen.add(id);
	}
	return true;
}
