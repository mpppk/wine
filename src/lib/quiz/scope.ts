import { getAop, listAops } from "#/lib/wine/service";
import type { Aop, RegionId } from "#/lib/wine/types";
import { candidateCountsByAopId, listCandidates } from "./generators";
import { parseKey } from "./keys";
import { AOP_ANSWER_QUIZ_TYPES, QUIZ_TYPE_IDS, type QuizType } from "./types";

// 地図の「選択中AOPに関連するクイズ」の出題スコープ。階層エッジを子方向にのみ辿る:
// 自身 + 配下の畑/ワイナリー + そこに内包される個別クリマ。
//
// 階層は2種類のエッジで表される(aop-schema.ts が相互排他を強制する):
//  - villageAopIds: 畑/ワイナリー → 所属する村名/地区AOC
//  - parentAopId  : 個別クリマ → 内包する親畑(シャブリ・グラン・クリュ等の傘AOC)
// 両方を辿らないと、傘AOC・村のどちらを選んでも配下クリマが1問も出ない(#243)。
// クリマは地域全体クイズには問題を供給しているので、辿らないとスコープ指定の時
// だけ出ないという非対称になる。
//
// 親方向へは辿らない。子ごとに固有のクイズだけを出題し、複数の子が親のクイズを
// 共有するのを避ける(#485: C案)。村/地方AOPは配下があれば含み(例: Haut-Médoc配下のシャトー)、
// 無ければ自身のみ(地域全体クイズとの重複を避ける)。
//
// 「自身が主語の候補問題を1問も持たない畑」(色・品種・地区が上位AOPと同一で
// 設問が上位側の1問に集約される(aop-pool.ts)もの。シャンベルタンやロマネ・コンティ等)は、
// スコープを自身のみとし、集約先(ジュヴレ・シャンベルタン等)の設問は借りない。
// 借りると7GC+村の全8スコープが同一の3キーに潰れ、毎回同じ3問が出続ける(#485)。
// 該当AOPのページではクイズ開始導線を出さず、母集団(村)のクイズへ誘導するCTAを出す
// (getQuizRedirectTargetId)。集約(#437)の傘ルール自体は変更しない。
//
// 借りない条件を「固有の設問が0問」に限るのではなく借用自体を廃止するのは、
// リストの各行の進捗(AOP単位の solved/total をスコープ集合で合算)とパネルの問題数を
// 一致させ続けるため。借用があると合算した分母がパネルの問題数と食い違う温床になる。

/** 選択AOPを階層近傍のAOP集合へ展開する。不明なslugなら null */
export function expandScopeAopIds(scopeAopId: string): Set<string> | null {
	const aop = getAop(scopeAopId);
	if (!aop) return null;
	const siblings = listAops({ regionId: aop.region });
	const ids = new Set<string>([aop.id]);
	// 1ホップ: この村/地区AOCに属する畑・ワイナリー
	for (const other of siblings) {
		if (other.villageAopIds?.includes(aop.id)) ids.add(other.id);
	}
	// 内包クリマ。傘AOCを選んだ場合は1ホップ、村を選んだ場合は上で入った傘畑を
	// 経由して2ホップで入る。クリマの入れ子(親畑もクリマ)もスキーマ上は書けるため、
	// 新たに増えなくなるまで繰り返して取り切る。
	const climatsByParent = new Map<string, string[]>();
	for (const other of siblings) {
		if (!other.parentAopId) continue;
		const known = climatsByParent.get(other.parentAopId);
		if (known) known.push(other.id);
		else climatsByParent.set(other.parentAopId, [other.id]);
	}
	const pending = [...ids];
	while (pending.length > 0) {
		const parentId = pending.pop() as string;
		for (const climatId of climatsByParent.get(parentId) ?? []) {
			if (ids.has(climatId)) continue;
			ids.add(climatId);
			pending.push(climatId);
		}
	}
	// 親方向へは辿らない(#485: C案)。固有の設問が0問の畑でも集約先の設問は借りず、
	// スコープは自身のみ(0問)とする。該当ページではクイズ導線の代わりに
	// getQuizRedirectTargetId() の母集団(村)へのCTAを出す。
	return ids;
}

/** そのAOP自身が主語の候補問題数(進捗の分母と同じ定義)。SSOT */
function countOwnQuestions(aop: Aop): number {
	return candidateCountsByAopId(aop.region).get(aop.id) ?? 0;
}

/**
 * 固有の設問が0問のAOPに対する、クイズ誘導先の母集団(村/地区)AOP。
 * 自身に固有の設問があるとき・不明なslugのときは null。
 * 集約先を階層エッジで上へ辿り、設問を持つ上位AOPに行き当たった最初の1件を返す。
 * 傘AOC自身も集約されていることがある(シャブリ・グラン・クリュのクリマ → 傘AOC →
 * シャブリ)ため、1ホップでは足りない。上位に設問を持つAOPが無い
 * (ドイツの広域・IGT等の開かれた呼称)ときは null。
 */
export function getQuizRedirectTargetId(aopId: string): string | null {
	const aop = getAop(aopId);
	if (!aop) return null;
	if (countOwnQuestions(aop) > 0) return null;
	const seen = new Set<string>([aop.id]);
	const pending: Aop[] = [aop];
	while (pending.length > 0) {
		const current = pending.pop() as Aop;
		const umbrellaIds = [
			...(current.parentAopId ? [current.parentAopId] : []),
			...(current.villageAopIds ?? []),
		];
		for (const umbrellaId of umbrellaIds) {
			if (seen.has(umbrellaId)) continue;
			seen.add(umbrellaId);
			const umbrella = getAop(umbrellaId);
			if (!umbrella) continue;
			if (countOwnQuestions(umbrella) > 0) return umbrellaId;
			// 上位も集約されている(0問)なら、さらに上の集約先まで辿る
			pending.push(umbrella);
		}
	}
	return null;
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
