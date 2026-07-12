import {
	AOP_TAG_LABELS_JA,
	AOP_TAGS,
	type AopTagId,
	primaryClassificationTag,
} from "./tags";
import type { Aop, AopKind } from "./types";

// 地図・リストの絞り込みモデル。
//
// ブルゴーニュの特級/1級のように、格付けは「畑」等の特定区分に付く属性であって
// 区分から独立した軸ではない。区分と格付けを独立の AND フィルタにすると「畑を除外
// ×特級のみ」のような 0 件確定の組み合わせが作れてしまう。そこで格付けを区分の
// 下位(サブ選択肢)として畳み込み、格付けタグを 2 つ以上持つ区分はマルチセレクト
// 化する。これによりその区分を表示せずに格付けだけ選ぶ状態が構造的に作れない。
//
// 地域ごとに格付けの担い手区分は異なる(ブルゴーニュ=畑/村、シャンパーニュ=村、
// ボルドー=ワイナリー、ピエモンテ=地方/村)ため、区分×格付けの構造は実データから
// 動的に導出する。

/** 格付けタグを持たないメンバーを表す facet(マルチセレクトの「格付けなし」選択肢)。 */
export const NO_CLASS_FACET = "__none__";
export type Facet = AopTagId | typeof NO_CLASS_FACET;

/** AOP_TAGS 内の並び(サブ選択肢の表示順を安定させる) */
const TAG_ORDER = new Map(AOP_TAGS.map((t, i) => [t.id, i] as const));

export interface KindFacets {
	kind: AopKind;
	/** この区分に実在する格付けタグ(AOP_TAGS 順)。primaryClassificationTag で 1 つに畳む */
	classTags: AopTagId[];
	/** 格付けタグを持たないメンバーが存在するか */
	hasUntagged: boolean;
	/** マルチセレクト化するか(格付けタグ 2 つ以上を持つ区分) */
	multi: boolean;
}

/** 地域の全 AOP から、区分ごとの格付け構造(サブ選択肢の有無)を導出する。 */
export function buildKindFacets(
	aops: Aop[],
	presentKinds: AopKind[],
): KindFacets[] {
	return presentKinds.map((kind) => {
		const tagSet = new Set<AopTagId>();
		let hasUntagged = false;
		for (const a of aops) {
			if (a.kind !== kind) continue;
			const t = primaryClassificationTag(a);
			if (t) tagSet.add(t);
			else hasUntagged = true;
		}
		const classTags = [...tagSet].sort(
			(a, b) => (TAG_ORDER.get(a) ?? 0) - (TAG_ORDER.get(b) ?? 0),
		);
		return { kind, classTags, hasUntagged, multi: classTags.length >= 2 };
	});
}

/** マルチセレクト区分のサブ選択肢(格付けタグ + 未格付けが居れば「格付けなし」)。 */
export function groupFacets(kf: KindFacets): Facet[] {
	if (!kf.multi) return [];
	return kf.hasUntagged ? [...kf.classTags, NO_CLASS_FACET] : [...kf.classTags];
}

/** 単純トグル区分のフィルタトークン(区分 ID そのもの)。 */
export function kindToken(kind: AopKind): string {
	return kind;
}

/** マルチセレクト区分の facet トークン(`区分:facet`)。 */
export function facetToken(kind: AopKind, facet: Facet): string {
	return `${kind}:${facet}`;
}

/** グループが持つ全トークン(既定=全選択の判定・URL 整形の基準順に使う)。 */
export function groupTokens(kf: KindFacets): string[] {
	if (!kf.multi) return [kindToken(kf.kind)];
	return groupFacets(kf).map((f) => facetToken(kf.kind, f));
}

/** AOP が属するフィルタトークン(可視判定用)。 */
export function aopToken(aop: Aop, byKind: Map<AopKind, KindFacets>): string {
	const kf = byKind.get(aop.kind);
	if (!kf?.multi) return kindToken(aop.kind);
	const t = primaryClassificationTag(aop);
	return facetToken(aop.kind, t ?? NO_CLASS_FACET);
}

/** サブ選択肢の表示名。 */
export function facetLabelJa(facet: Facet): string {
	return facet === NO_CLASS_FACET ? "格付けなし" : AOP_TAG_LABELS_JA[facet];
}
