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
// 親方向へは原則辿らない。子ごとに固有のクイズだけを出題し、複数の子が親のクイズを
// 共有するのを避ける。村/地方AOPは配下があれば含み(例: Haut-Médoc配下のシャトー)、
// 無ければ自身のみ(地域全体クイズとの重複を避ける)。
//
// 例外は「自身が主語の候補問題を1問も持たない畑」。色・品種・地区が上位AOPと同一の
// 畑は設問が上位側の1問に集約される(aop-pool.ts)ため、シャンベルタンやロマネ・コンティの
// ように固有の設問が1つも残らないことがある。この場合だけ上位方向へ辿り、集約先
// (ジュヴレ・シャンベルタン等)の設問を借りる。設問キーは集約先のものなので、同じ村の
// 畑同士・村自身とクイズと進捗をそのまま共有する。
//
// 借りる条件を「固有の設問が0問」に限るのは、リストの各行の進捗(AOP単位の solved/total を
// スコープ集合で合算)とパネルの問題数を一致させ続けるため。固有の設問を持つ畑まで上位の
// 設問を借りると、合算した分母がパネルの問題数を上回る。

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
	// 固有の設問が1問も無い畑だけ、集約先(上位AOP)の設問を借りる。上で入れた配下からは
	// 辿らない(選択AOP自身の集約先だけを足す)ので、村を経由して兄弟の設問までは広がらない。
	for (const umbrellaId of listShareableUmbrellaAopIds(aop)) ids.add(umbrellaId);
	return ids;
}

/** そのAOP自身が主語の候補問題数(進捗の分母と同じ定義) */
function countOwnQuestions(aop: Aop): number {
	return candidateCountsByAopId(aop.region).get(aop.id) ?? 0;
}

/**
 * 設問を借りる先の上位AOP。自身に固有の設問が無いときだけ、設問を持つ上位AOPに
 * 行き当たるまで階層エッジを上へ辿る。傘AOC自身も上位へ集約されていることがある
 * (シャブリ・グラン・クリュのクリマ → 傘AOC → シャブリ)ため、1ホップでは足りない。
 */
function listShareableUmbrellaAopIds(aop: Aop): string[] {
	if (countOwnQuestions(aop) > 0) return [];
	const shared: string[] = [];
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
			shared.push(umbrellaId);
			// 上位も集約されている(0問)なら、さらに上の集約先まで辿る
			if (countOwnQuestions(umbrella) === 0) pending.push(umbrella);
		}
	}
	return shared;
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
