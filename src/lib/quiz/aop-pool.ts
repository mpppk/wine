import { listAops } from "#/lib/wine/service";
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
