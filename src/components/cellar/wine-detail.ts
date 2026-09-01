import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { getAop, getRegion, getVariety } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// 閲覧専用画面(/cellar/$entryId)の項目一覧を作る純ロジック。表示コンポーネントから
// 切り出してあるのは、「どの項目をどう文字にするか」だけを単体テストで固定するため。
//
// ID→表示名の解決(地域・AOP・ぶどう品種)は静的マスタ(src/lib/wine/)を引く。
// 編集フォーム(DrunkWineFields)が選択肢を出すのと同じ情報源なので、編集画面で
// 選んだ名前と閲覧画面の表示が食い違わない。

/**
 * 産地の学習地図(/map/$regionId)への遷移先。この値を持つ行は表示側でリンクとして
 * 描く。aopId があれば地図側がそのAOPを選択した状態(ポリゴンへズーム+詳細パネル)で
 * 開き、無ければ地域全体を開く。
 *
 * ここで「行 → 遷移先」まで決めてしまうのは、リンクを出す条件(マスタに現存するか・
 * 地域が公開済みか)が表示の都合ではなくデータの性質だから。表示側は link の有無だけ
 * を見ればよく、条件は単体テストで固定できる。
 */
export interface WineDetailMapLink {
	regionId: RegionId;
	/** 省略時は地域全体を開く */
	aopId?: string;
}

export interface WineDetailRow {
	label: string;
	value: string;
	link?: WineDetailMapLink;
}

/**
 * 地図を開ける地域か。enabled=false の地域は /map/$regionId が /regions へ
 * リダイレクトするため、リンクにすると「押しても産地が出ない」導線になる。
 */
function isMappableRegion(regionId: RegionId): boolean {
	return getRegion(regionId)?.enabled === true;
}

/**
 * 閲覧画面に並べる「銘柄の属性」の行。値が無い項目は行ごと落とす(空欄の
 * ラベルだけが並ぶのを避ける)。
 *
 * 飲用記録(1:N)の飲んだ日・評価・メモはここに含めない。銘柄の属性ではなく、
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
		rows.push({
			label: "地域",
			value: region.nameJa,
			link: region.enabled ? { regionId: region.id } : undefined,
		});
	}
	// aopNameJa はサーバがマスタから導出済み。取れていないときだけ自前で引く
	// (静的マスタの更新でIDだけ残っているケースの保険)
	const aop = entry.aopId ? getAop(entry.aopId) : undefined;
	const aopName = entry.aopNameJa ?? aop?.nameJa;
	if (aopName) {
		rows.push({
			label: "AOP",
			value: aopName,
			// 地図で開けるのはマスタに現存するAOPだけ。地図側は現行IDでしか選択でき
			// ないので、退役IDで保存された行は getAop が解決した後継のIDを渡す(#333)。
			link:
				aop && isMappableRegion(aop.region)
					? { regionId: aop.region, aopId: aop.id }
					: undefined,
		});
	}

	const grapes = entry.grapeVarietyIds
		.map((id) => getVariety(id)?.nameJa)
		.filter((name): name is string => Boolean(name));
	if (grapes.length > 0) {
		rows.push({ label: "ぶどう品種", value: grapes.join("、") });
	}

	return rows;
}
