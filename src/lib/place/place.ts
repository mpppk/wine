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

/**
 * 同名の場所は作れない(重複の関門は `prepareNewPlace`)。その文言はサーバの 409 と
 * 入力欄の事前警告の両方に出るので、ここを単一情報源にする——片方だけ変えると
 * 「入力中に出る注意書き」と「保存に失敗したときの説明」が食い違う。
 */
export function duplicatePlaceNameMessage(name: string): string {
	return `「${name}」という場所は既に登録されています。一覧から選んでください。`;
}
