import { isTasted, type WineStatus } from "./status";

// マイセラー一覧・地図の絞り込み条件。両ページが同じ述語を使う単一情報源
// (経路ごとに条件を書くとドリフトする。#177 / #185)。
//
// チップは排他タブではなく独立した絞り込み条件で、1本のワインが「飲んだことがある」
// と「セラーにある」の両方に該当しうる(＝以前飲んで買い直したケース)。
export const CELLAR_FILTERS = [
	{ id: "all", labelJa: "すべて" },
	{ id: "tasted", labelJa: "飲んだことがある" },
	{ id: "owned", labelJa: "セラーにある" },
	{ id: "wishlist", labelJa: "気になる" },
] as const;

export type CellarFilterId = (typeof CELLAR_FILTERS)[number]["id"];

export const CELLAR_FILTER_IDS = CELLAR_FILTERS.map((f) => f.id) as [
	CellarFilterId,
	...CellarFilterId[],
];

export const DEFAULT_CELLAR_FILTER: CellarFilterId = "all";

/** 絞り込みの判定に必要な最小の形。DrunkWineEntry がこれを満たす */
export interface CellarFilterable {
	status: WineStatus;
	tastingCount: number;
}

export function matchesCellarFilter(
	entry: CellarFilterable,
	filter: CellarFilterId,
): boolean {
	switch (filter) {
		case "all":
			return true;
		case "tasted":
			return isTasted(entry);
		case "owned":
			return entry.status === "owned";
		case "wishlist":
			return entry.status === "wishlist";
	}
}

/** チップの件数バッジ用。全チップぶんを1回の走査で数える */
export function countCellarFilters(
	entries: readonly CellarFilterable[],
): Record<CellarFilterId, number> {
	const counts = Object.fromEntries(
		CELLAR_FILTER_IDS.map((id) => [id, 0]),
	) as Record<CellarFilterId, number>;
	for (const entry of entries) {
		for (const id of CELLAR_FILTER_IDS) {
			if (matchesCellarFilter(entry, id)) counts[id] += 1;
		}
	}
	return counts;
}
