import type { Aop } from "./types";

// AOPに付与できるタグのレジストリ(真実の源)。aop-schema.ts が z.enum で参照する
// ため、aops.json に未知のタグIDが入るとロード時に弾かれる。
// labelJa はフィルタチップ・詳細バッジの表示名、badgeJa はツリー行の短縮ラベル。
//
// 格付けは地域ごとに制度が異なる:
//  - ブルゴーニュ/シャンパーニュ: 特級(grand-cru)/一級(premier-cru)
//  - ボルドー・メドック/ソーテルヌ 1855年格付け: 第1級〜第5級(+ソーテルヌの特別第1級)
//  - ボルドー・サンテミリオン格付け: 第1特別級A/B
export const AOP_TAGS = [
	{ id: "grand-cru", labelJa: "特級" },
	{ id: "premier-cru", labelJa: "一級", badgeJa: "1er" },
	{
		id: "premier-cru-superieur-1855",
		labelJa: "特別第1級(1855)",
		badgeJa: "特1級",
	},
	{ id: "premier-cru-classe-1855", labelJa: "第1級(1855)", badgeJa: "1級" },
	{ id: "deuxieme-cru-classe-1855", labelJa: "第2級(1855)", badgeJa: "2級" },
	{ id: "troisieme-cru-classe-1855", labelJa: "第3級(1855)", badgeJa: "3級" },
	{ id: "quatrieme-cru-classe-1855", labelJa: "第4級(1855)", badgeJa: "4級" },
	{ id: "cinquieme-cru-classe-1855", labelJa: "第5級(1855)", badgeJa: "5級" },
	{
		id: "premier-grand-cru-classe-a",
		labelJa: "サンテミリオン第1特別級A",
		badgeJa: "A",
	},
	{
		id: "premier-grand-cru-classe-b",
		labelJa: "サンテミリオン第1特別級B",
		badgeJa: "B",
	},
	// イタリアの格付け(区分ではなく法的等級なのでタグで表現)
	{ id: "docg", labelJa: "DOCG" },
	{ id: "doc", labelJa: "DOC" },
] as const;

export type AopTagId = (typeof AOP_TAGS)[number]["id"];

export const AOP_TAG_IDS = AOP_TAGS.map((t) => t.id) as [
	AopTagId,
	...AopTagId[],
];

export const AOP_TAG_LABELS_JA: Record<AopTagId, string> = Object.fromEntries(
	AOP_TAGS.map((t) => [t.id, t.labelJa]),
) as Record<AopTagId, string>;

/** ツリー行の右端に出す短縮バッジ。定義の無いタグ(grand-cru等)はドット色で表現する */
export const AOP_TAG_BADGES_JA: Partial<Record<AopTagId, string>> =
	Object.fromEntries(
		AOP_TAGS.flatMap((t) => ("badgeJa" in t ? [[t.id, t.badgeJa]] : [])),
	);

/**
 * 格付けの序列(小さいほど上位)。同一村内でシャトーを格付け順に並べるのに使う。
 * 制度をまたぐ絶対比較には使わない(1855の第1級とサンテミリオンAは別制度)。
 */
export const CLASSIFICATION_TAG_RANK: Partial<Record<AopTagId, number>> = {
	"grand-cru": 0,
	"premier-cru": 1,
	"premier-cru-superieur-1855": 0,
	"premier-cru-classe-1855": 1,
	"deuxieme-cru-classe-1855": 2,
	"troisieme-cru-classe-1855": 3,
	"quatrieme-cru-classe-1855": 4,
	"cinquieme-cru-classe-1855": 5,
	"premier-grand-cru-classe-a": 1,
	"premier-grand-cru-classe-b": 2,
};

/** AOPの最上位(最小ランク)格付けタグの序列。タグ無しは最後(Infinity)に置く */
export function classificationRank(aop: Aop): number {
	let rank = Number.POSITIVE_INFINITY;
	for (const tag of aop.tags ?? []) {
		const r = CLASSIFICATION_TAG_RANK[tag];
		if (r !== undefined && r < rank) rank = r;
	}
	return rank;
}

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

/**
 * このAOPが「法的に独立した原産地呼称(AOC/AOP・DOC/DOCG)」かを返す。
 *
 * 「クリマ(畑)である」ことと「AOCである」ことは直交する — モンラッシェはクリマ
 * かつ単独AOC、レ・クロはクリマだが非AOC(Chablis Grand Cru AOC内の区画)。よって
 * この判定は kind から推論せず、明示フィールド(isAppellation)と地域の格付け制度の
 * ドメイン規則だけで決める。表示バッジ(AOC/非AOC)はこの関数だけを唯一の権威とする。
 */
export function isLegalAppellation(aop: Aop): boolean {
	if (aop.isAppellation !== undefined) return aop.isAppellation; // 明示優先
	if (aop.kind === "winery") return false; // シャトー等は生産者でありAOCではない
	// シャンパーニュのグラン/プルミエ・クリュ村はエシェル・デ・クリュ(村の格付け)で
	// あってAOCではない(AOCは「Champagne」)。formatAopTagJa と同じドメイン知識。
	if (
		aop.region === "champagne" &&
		aop.kind === "village" &&
		(aop.tags?.includes("grand-cru") || aop.tags?.includes("premier-cru"))
	) {
		return false;
	}
	return true; // regional / village / vineyard は既定でアペラシオン
}
