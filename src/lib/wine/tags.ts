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
	{ id: "grand-cru", labelJa: "特級", badgeJa: "特級" },
	{ id: "premier-cru", labelJa: "一級", badgeJa: "1級" },
	{
		id: "premier-cru-superieur-1855",
		labelJa: "特別第1級(1855年)",
		badgeJa: "特1級",
	},
	{ id: "premier-cru-classe-1855", labelJa: "第1級(1855年)", badgeJa: "1級" },
	{ id: "deuxieme-cru-classe-1855", labelJa: "第2級(1855年)", badgeJa: "2級" },
	{ id: "troisieme-cru-classe-1855", labelJa: "第3級(1855年)", badgeJa: "3級" },
	{ id: "quatrieme-cru-classe-1855", labelJa: "第4級(1855年)", badgeJa: "4級" },
	{ id: "cinquieme-cru-classe-1855", labelJa: "第5級(1855年)", badgeJa: "5級" },
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
	// グラーヴ1959年格付けは等級を分けない単一クラス(赤/白の別はあるが上下は無い)
	{
		id: "cru-classe-de-graves",
		labelJa: "グラーヴ格付け(1959年)",
		badgeJa: "GC",
	},
	// イタリアの格付け(区分ではなく法的等級なのでタグで表現)
	{ id: "docg", labelJa: "DOCG" },
	{ id: "doc", labelJa: "DOC" },
	// IGT(Indicazione Geografica Tipica) は DOC/DOCG の下位にある法的呼称。
	// スーパートスカーナ(Tignanello / Masseto / Le Pergole Torte 等)は DOC(G) の
	// 規定に縛られないためこの呼称を名乗る。#212
	{ id: "igt", labelJa: "IGT" },
] as const;

export type AopTagId = (typeof AOP_TAGS)[number]["id"];

export const AOP_TAG_IDS = AOP_TAGS.map((t) => t.id) as [
	AopTagId,
	...AopTagId[],
];

export const AOP_TAG_LABELS_JA: Record<AopTagId, string> = Object.fromEntries(
	AOP_TAGS.map((t) => [t.id, t.labelJa]),
) as Record<AopTagId, string>;

/** ツリー行の右端に出す短縮バッジ。badgeJa の無いタグ(docg/doc等)はバッジ無し */
const AOP_TAG_BADGES_JA: Partial<Record<AopTagId, string>> = Object.fromEntries(
	AOP_TAGS.flatMap((t) => ("badgeJa" in t ? [[t.id, t.badgeJa]] : [])),
);

/**
 * リスト行に出す格付けバッジの文言。格付けタグを持たない AOP は undefined。
 * 特級・1級を含め、AOP 自身の格付けを短縮表記で示す(特級=特級 / 1級=1級 …)。
 * ただし村名の premier-cru(=村内に 1er Cru 区画がある「1er Cruあり」の意で、村
 * 自体は 1 級ではない。formatAopTagJa と同じドメイン規則)はバッジを出さない。
 */
export function classificationBadgeJa(aop: Aop): string | undefined {
	const tag = primaryClassificationTag(aop);
	if (!tag) return undefined;
	if (
		tag === "premier-cru" &&
		aop.kind === "village" &&
		aop.region !== "champagne"
	) {
		return undefined;
	}
	return AOP_TAG_BADGES_JA[tag];
}

/**
 * 詳細パネルで AOC バッジと並べて出す「格付けバッジ」の文言(フル表記)。
 * 実際に格付けを持つ AOP のみ返す(特級/一級/DOCG/DOC/第1級(1855)/A …)。
 * ブルゴーニュ村名の premier-cru は「村内に 1er Cru 区画がある」意で村自体は
 * 格付けを持たないため undefined(バッジを出さない)。classificationBadgeJa /
 * formatAopTagJa と同じドメイン規則。
 *
 * igt も undefined。IGT は「呼称そのもの」であり格付けの階級ではないため、
 * 呼称バッジ(getAppellationBadgeJa)が既に "IGT" を出す。両方返すと詳細パネルに
 * 「IGT」が2つ並ぶ。呼称名の表示は呼称バッジ側を唯一の担当とする。
 */
export function classificationPanelBadgeJa(aop: Aop): string | undefined {
	const tag = primaryClassificationTag(aop);
	if (!tag) return undefined;
	if (tag === "igt") return undefined;
	if (
		tag === "premier-cru" &&
		aop.kind === "village" &&
		aop.region !== "champagne"
	) {
		return undefined;
	}
	return formatAopTagJa(aop, tag);
}

/**
 * 格付けの序列(小さいほど上位)。同一村内でシャトーを格付け順に並べるのに使う。
 * 制度をまたぐ絶対比較には使わない(1855の第1級とサンテミリオンAは別制度)。
 */
const CLASSIFICATION_TAG_RANK: Partial<Record<AopTagId, number>> = {
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
	// グラーヴ格付けは単一クラスなので、制度内で並べ替える必要が無い。
	// ランクを持たせないと getPrimaryClassificationTag が tags 先頭に落ちるため、
	// 1855年第1級の Haut-Brion と同じ村に並んだときに順序が不定になる。
	// 制度内で唯一の等級として 1 を置く(制度をまたぐ比較には使わない)。
	"cru-classe-de-graves": 1,
};

/**
 * AOPの主たる格付けタグ。ランク定義のあるタグの中で最上位(最小ランク)を優先し、
 * ランク定義の無い法的等級(docg/doc 等)しか無い場合は tags 先頭を返す。
 * 格付けタグを持たないAOPは undefined。
 */
export function primaryClassificationTag(aop: Aop): AopTagId | undefined {
	const tags = aop.tags ?? [];
	if (tags.length === 0) return undefined;
	let best: AopTagId | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const tag of tags) {
		const r = CLASSIFICATION_TAG_RANK[tag];
		if (r !== undefined && r < bestRank) {
			bestRank = r;
			best = tag;
		}
	}
	return best ?? tags[0];
}

/** AOPの格付け表示ラベル(文脈依存、formatAopTagJa 準拠)。格付けタグが無ければ undefined */
export function aopClassificationLabel(aop: Aop): string | undefined {
	const tag = primaryClassificationTag(aop);
	return tag ? formatAopTagJa(aop, tag) : undefined;
}

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
	// IGT は DOC/DOCG の下位だが、EU の IGP に対応する法的呼称であって「非AOC」では
	// ない。よってここでは true を返し、呼称バッジ側(getAppellationBadgeJa)が
	// "DOC/DOCG" ではなく "IGT" を出すことで階級の違いを示す。#212
	return true; // regional / village / vineyard は既定でアペラシオン
}
