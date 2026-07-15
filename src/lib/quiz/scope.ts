import { getAop, listAops } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { listCandidates } from "./generators";
import { parseKey } from "./keys";
import { AOP_ANSWER_QUIZ_TYPES, QUIZ_TYPE_IDS, type QuizType } from "./types";

// 地図の「選択中AOPに関連するクイズ」の出題スコープ。villageAopIds エッジを
// 子方向にのみ辿る: 自身 + 配下の畑/ワイナリー。
// 畑/ワイナリーは親の村名AOCを含めない(複数の畑が村クイズを共有するのを避け、
// 畑ごとに固有のクイズだけを出題する)。村/地方AOPは配下があれば含み
// (例: Haut-Médoc配下のシャトー)、無ければ自身のみ(地域全体クイズとの重複を避ける)。

/** 選択AOPを階層近傍のAOP集合へ展開する。不明なslugなら null */
export function expandScopeAopIds(scopeAopId: string): Set<string> | null {
	const aop = getAop(scopeAopId);
	if (!aop) return null;
	const ids = new Set<string>([aop.id]);
	for (const other of listAops({ regionId: aop.region })) {
		if (other.villageAopIds?.includes(aop.id)) ids.add(other.id);
	}
	return ids;
}

/**
 * スコープ内のAOPを対象とする候補キーだけに絞る。
 * slugが不明、または指定地域のAOPでなければ null(呼び出し側でエラーにする)
 */
export function listScopedCandidates(
	regionId: RegionId,
	quizTypes: QuizType[],
	scopeAopId: string,
): string[] | null {
	const aop = getAop(scopeAopId);
	if (!aop || aop.region !== regionId) return null;
	// getAop で存在確認済みなので expandScopeAopIds が null を返すことはない
	const subjects = expandScopeAopIds(scopeAopId);
	if (!subjects) return null;
	return listCandidates(regionId, quizTypes).filter((key) => {
		const parsed = parseKey(key);
		if (parsed === null || !subjects.has(parsed.aopId)) return false;
		// 「その地域に関連するクイズ」= 設問文の主語がスコープ内AOPの形式だけ。
		// AOPが4択の正解にすぎない形式(odd-one-out / variety / location)は、
		// たまたま正解が近傍AOPになるだけで設問はそのAOPに関する問いではないため除外。
		// (これにより、選択AOPやその親子が正解になる自明問題も自動的に消える)
		return !AOP_ANSWER_QUIZ_TYPES.has(parsed.quizType);
	});
}

/** スコープ内の候補問題数(詳細パネルのボタン表示可否・問数表示に使う) */
export function countScopedQuestions(
	regionId: RegionId,
	scopeAopId: string,
): number {
	return (
		listScopedCandidates(regionId, [...QUIZ_TYPE_IDS], scopeAopId)?.length ?? 0
	);
}
