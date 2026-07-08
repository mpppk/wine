import type { Aop } from "./types";

// AOPに付与できるタグのレジストリ(真実の源)。aop-schema.ts が z.enum で参照する
// ため、aops.json に未知のタグIDが入るとロード時に弾かれる。
export const AOP_TAGS = [
	{ id: "grand-cru", labelJa: "特級" },
	{ id: "premier-cru", labelJa: "一級" },
] as const;

export type AopTagId = (typeof AOP_TAGS)[number]["id"];

export const AOP_TAG_IDS = AOP_TAGS.map((t) => t.id) as [
	AopTagId,
	...AopTagId[],
];

export const AOP_TAG_LABELS_JA: Record<AopTagId, string> = Object.fromEntries(
	AOP_TAGS.map((t) => [t.id, t.labelJa]),
) as Record<AopTagId, string>;

/**
 * タグの文脈依存の表示名を返す。premier-cru は地域で意味が変わる:
 * シャンパーニュはエシェル・デ・クリュで村自体が一級だが、ブルゴーニュ等では
 * 「村名AOC内に1er Cru区画がある」ことを表すため「1er Cruあり」と表示する。
 */
export function formatAopTagJa(aop: Aop, tagId: AopTagId): string {
	if (
		tagId === "premier-cru" &&
		aop.kind === "village" &&
		aop.region !== "champagne"
	) {
		return "1er Cruあり";
	}
	return AOP_TAG_LABELS_JA[tagId];
}
