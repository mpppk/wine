import { getAop, listAops } from "#/lib/wine/service";
import type { Aop } from "#/lib/wine/types";

// 品種・色を「主張する」形式のための共通の出題プール。IGT のような開かれた
// 広域呼称を一箇所で除外するためのチョークポイント(#212)。
//
// 形式ごとに個別に除外条件を書くと、後から足した形式で必ず適用漏れする
// (CLAUDE.md「横断的な防御・規約は共通チョークポイント(SSOT)に寄せる」)。

/**
 * 許可品種・生産可能タイプが事実上「その州で認められた全品種・全タイプ」に
 * 開かれている広域呼称(IGT)か。
 *
 * DOC(G) は生産規約(disciplinare)が品種と色を閉じた集合として定めるため、
 * `aops.json` の `grapes` / `colors` はその集合そのものを写せる。対して IGT の
 * 規約は「州で栽培が認められた品種」を丸ごと許すので、収録している品種・色は
 * 代表例にすぎず網羅ではない。
 *
 * このため「〜の使用が認められていないAOPはどれ？」「〜の主要品種はどれ？」の
 * ように**収録データが網羅であることを前提に真偽を主張する形式**に載せると、
 * 事実と異なる設問・解説を生む。該当形式では出題主体にも選択肢にもしない。
 *
 * 格付けクイズ(aop-classification)は「その呼称の格付けは何か」を問うだけで
 * 品種・色を主張しないため、この除外の対象外(IGT も出題してよい)。
 */
export function isOpenEndedAppellation(aop: Aop): boolean {
	return aop.tags?.includes("igt") ?? false;
}

/** 品種・色を主張する形式で使ってよいAOPだけに絞った listAops */
export const listClosedListAops: typeof listAops = (filter) =>
	listAops(filter).filter((a) => !isOpenEndedAppellation(a));

/**
 * 畑・シャトーを内包する上位AOP(傘AOC/村名AOC)。階層エッジは2種類あり、
 * スキーマ上は相互排他(`aop-schema.ts`):
 *  - parentAopId : 個別クリマ → 内包する親畑(シャブリ・グラン・クリュ等の傘AOC)
 *  - villageAopIds: 畑/シャトー → 所属する村名AOC(複数村にまたがる畑は複数)
 *
 * 両方を辿るのは、同じ「上位と同一内容」の重複が構造の違いで取りこぼされるため。
 * シャブリ・グラン・クリュ配下の7クリマは単一AOC内のリュー・ディなので
 * parentAopId を持つが、シャンベルタン群はそれぞれが独立したAOCで法的な親AOCが
 * 無く villageAopIds でジュヴレ・シャンベルタンに繋がる。#373 が parentAopId
 * だけを見ていたため、後者は集約されず同一内容の設問が畑の数だけ残っていた。
 */
function listUmbrellaAops(aop: Aop): Aop[] | undefined {
	const ids = [
		...(aop.parentAopId ? [aop.parentAopId] : []),
		...(aop.villageAopIds ?? []),
	];
	if (ids.length === 0) return undefined;
	const umbrellas: Aop[] = [];
	for (const id of ids) {
		const umbrella = getAop(id);
		// 参照先が引けないなら集約先が確かめられないので集約しない(設問を残す)
		if (!umbrella) return undefined;
		umbrellas.push(umbrella);
	}
	return umbrellas;
}

/**
 * 畑・シャトーの設問が、それを内包する上位AOP(傘AOC/村名AOC)の同型設問と同一内容に
 * なるか。畑は上位AOPと地理的に重なり、規約上の事実(色・品種・地区・格付け等)の多くを
 * そのまま引き継ぐ。値が上位と同じ事実を畑ごとに出題すると、名前だけ違う同一内容の
 * クイズが畑の数だけ並ぶ(ジュヴレ・シャンベルタンの9グラン・クリュ等)。その場合は
 * 上位側の1問に集約し、畑側では出題しない。
 *
 * 上位と値が異なる事実(コルトンの各クリマの色・品種、ミュジニーの色など)は畑固有の
 * 学びなので出題対象のまま残る。複数村にまたがる畑は**全ての村と一致するときだけ**
 * 集約する。一村でも値が違えばその村のスコープでは固有の事実になり、集約すると
 * その村から学びが消えるため(ボンヌ・マールは赤のみで、モレ・サン・ドニは赤・白)。
 *
 * fact には形式ごとの「正解を表す値」を渡す(colors ならコンボID、subregion なら
 * subregionId 等)。**その形式で出題対象にならないAOPには undefined を返すこと**。
 * 集約は「上位側が同型の1問を出す」ことが前提で、上位が出題対象外なら集約先が無く、
 * 事実がどこからも出題されなくなる(オー・メドックは広域AOCで地区クイズの主語に
 * ならないため、配下シャトーの地区設問は集約できない)。
 */
export function duplicatesUmbrellaFact(
	aop: Aop,
	fact: (a: Aop) => string | undefined,
): boolean {
	const umbrellas = listUmbrellaAops(aop);
	if (!umbrellas) return false;
	const value = fact(aop);
	if (value === undefined || value === "") return false;
	return umbrellas.every((umbrella) => fact(umbrella) === value);
}
