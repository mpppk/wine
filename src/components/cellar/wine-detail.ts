import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { getAop, getRegion, getVariety } from "#/lib/wine/service";

// 閲覧専用画面(/cellar/$entryId)の項目一覧を作る純ロジック。表示コンポーネントから
// 切り出してあるのは、「どの項目をどう文字にするか」だけを単体テストで固定するため。
//
// ID→表示名の解決(地域・AOP・ぶどう品種)は静的マスタ(src/lib/wine/)を引く。
// 編集フォーム(DrunkWineFields)が選択肢を出すのと同じ情報源なので、編集画面で
// 選んだ名前と閲覧画面の表示が食い違わない。

export interface WineDetailRow {
	label: string;
	value: string;
}

/**
 * 閲覧画面に並べる「銘柄の属性」の行。値が無い項目は行ごと落とす(空欄の
 * ラベルだけが並ぶのを避ける)。
 *
 * 飲んだ日・評価・メモはここに含めない。飲用記録(1:N)は銘柄の属性ではなく、
 * 別セクションで件数ぶん並べるため(Issue #195 の2軸分離と同じ切り分け)。
 */
export function buildWineDetailRows(entry: DrunkWineEntry): WineDetailRow[] {
	const rows: WineDetailRow[] = [
		{ label: "状態", value: WINE_STATUS_LABELS_JA[entry.status] },
	];

	if (entry.vintage !== null) {
		rows.push({ label: "ヴィンテージ", value: `${entry.vintage}年` });
	}
	if (entry.producer) {
		rows.push({ label: "生産者", value: entry.producer });
	}
	// 未購入(wishlist)では価格を出さない。DrunkWineFields が同じ条件で入力欄を
	// 隠しており、編集画面に無い値を閲覧画面だけが表示すると「消せない価格」に見える。
	if (entry.price !== null && entry.status !== "wishlist") {
		rows.push({
			label: "価格",
			value: `¥${entry.price.toLocaleString("ja-JP")}`,
		});
	}

	const region = entry.regionId ? getRegion(entry.regionId) : undefined;
	if (region) {
		rows.push({ label: "地域", value: region.nameJa });
	}
	// aopNameJa はサーバがマスタから導出済み。取れていないときだけ自前で引く
	// (静的マスタの更新でIDだけ残っているケースの保険)
	const aopName =
		entry.aopNameJa ?? (entry.aopId ? getAop(entry.aopId)?.nameJa : undefined);
	if (aopName) {
		rows.push({ label: "AOP", value: aopName });
	}

	const grapes = entry.grapeVarietyIds
		.map((id) => getVariety(id)?.nameJa)
		.filter((name): name is string => Boolean(name));
	if (grapes.length > 0) {
		rows.push({ label: "ぶどう品種", value: grapes.join("、") });
	}

	return rows;
}
