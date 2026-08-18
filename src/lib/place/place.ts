// 場所(place)の区分レジストリ(真実の源)。zod(schema.ts)・DB(db/schema.ts の
// $type)・UI のラベルがすべてここから導出される(WINE_STATUSES と同じ形)。
//
// 場所は「どの店でそのワインを見かけたか」を持つためのユーザ単位マスタ(Issue #358)。
// 区分はレストラン/ショップ/その他の3値に留める。細分化しても目撃記録の意味は
// 変わらず、増やすほど入力時の選択コストだけが上がるため。

export const PLACE_KINDS = [
	{ id: "restaurant", labelJa: "レストラン" },
	{ id: "shop", labelJa: "ショップ" },
	{ id: "other", labelJa: "その他" },
] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number]["id"];

export const PLACE_KIND_IDS = PLACE_KINDS.map((k) => k.id) as [
	PlaceKind,
	...PlaceKind[],
];

/**
 * 区分を選ばずに場所を作れるようにするための既定値。
 * マイグレーションの DEFAULT と必ず同じ値にする。
 */
export const DEFAULT_PLACE_KIND: PlaceKind = "other";
