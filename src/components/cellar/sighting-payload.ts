import {
	EMPTY_SIGHTING_DRAFT,
	NEW_PLACE_VALUE,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import type {
	CreateEntrySightingInput,
	CreateWineSightingInput,
	UpdateWineSightingInput,
} from "#/lib/place/schema";
import type { WineSightingEntry } from "#/lib/services/drunk-wine-service";
import type { LabelJobSighting } from "#/lib/services/label-job-service";

// 目撃記録フォームの送信ペイロード生成。コンポーネント本体(SightingList)は
// server fn 経由で cloudflare:workers に到達するため unit テストできないので、
// 変換だけを純関数として切り出す(drunk-wine-payload.ts と同じ方針)。
//
// パッチ規約は銘柄・飲用記録と揃える: **追加は空欄を送らない / 更新は空欄を null で
// 送ってクリアする**。片方だけ違う規約にすると「消したつもりが消えない」が起きる。

/** 既存の目撃記録をフォーム値へ写す。 */
export function draftFromSighting(entry: WineSightingEntry): WineSightingDraft {
	return {
		placeId: entry.placeId ?? "",
		// 既存の記録は場所が確定しているので、新規作成の入力は常に空
		newPlaceName: "",
		seenOn: entry.seenOn ?? "",
		price: entry.price != null ? String(entry.price) : "",
		memo: entry.memo ?? "",
	};
}

/**
 * 解析ジョブに残っていた「どこで・いつ撮ったか」をフォーム値へ写す(#498)。
 *
 * 新規作成の場所は place 行がまだ無いので、名前を持ったまま「新しい場所を追加…」の
 * 選択状態にする(投入時と同じ見え方で復元する)。
 */
export function draftFromLabelJobSighting(
	sighting: LabelJobSighting,
): WineSightingDraft {
	return {
		...EMPTY_SIGHTING_DRAFT,
		...(sighting.newPlaceName
			? { placeId: NEW_PLACE_VALUE, newPlaceName: sighting.newPlaceName }
			: sighting.placeId
				? { placeId: sighting.placeId }
				: {}),
		...(sighting.seenOn ? { seenOn: sighting.seenOn } : {}),
	};
}

/** 数値入力(文字列)を整数に寄せる。空・数値化できない値は undefined。 */
function toIntOrUndefined(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 場所の選択をペイロードの形に写す。「新しい場所を追加…」は `newPlace` になる。
 *
 * 名前が空なら「場所の指定なし」に倒す(`buildCreateEntrySightingInput` と同じ規約)。
 * 選択だけして名前を書かずに保存した回を弾くより、見かけた事実を残すほうが記録の
 * 敷居が低い。**更新時は `null`(クリア)、追加時は未指定**と意味が分かれるので、
 * 「場所なし」のときに載せるキーは呼び出し側から受け取る。
 */
function placePayload<T extends object>(draft: WineSightingDraft, noPlace: T) {
	if (draft.placeId === NEW_PLACE_VALUE) {
		const name = draft.newPlaceName.trim();
		return name ? { newPlace: { name } } : noPlace;
	}
	return draft.placeId ? { placeId: draft.placeId } : noPlace;
}

/**
 * 追加時の入力。空欄のフィールドは送らない(= サーバ側で null になる)。
 *
 * 場所はその場で新規作成できる(編集画面の「見かけた記録」からも作れるようにしたため)。
 * 同名の場所が既にあればサーバ(`prepareNewPlace`)が 409 で弾く。
 */
export function buildAddSightingInput(
	draft: WineSightingDraft,
): CreateWineSightingInput {
	const memo = draft.memo.trim();
	return {
		...placePayload(draft, {}),
		...(draft.seenOn ? { seenOn: draft.seenOn } : {}),
		...(toIntOrUndefined(draft.price) != null
			? { price: toIntOrUndefined(draft.price) }
			: {}),
		...(memo ? { memo } : {}),
	};
}

/**
 * 銘柄の新規作成に添える目撃記録(#495)。**全欄が空なら undefined**(記録を作らない)
 * ——飲用記録の `buildTastingInput` と同じ規約で、写真から登録した回に場所も日付も
 * 入れていなければ目撃記録は生まれない。
 *
 * 新規作成の場所は名前が空なら「場所の指定なし」に倒す。選択だけして名前を書かずに
 * 保存した回で登録ごと弾くより、見かけた事実を残すほうが記録の敷居が低い
 * (place は名前必須なので、空のまま送ればサーバの zod で落ちる)。
 */
export function buildCreateEntrySightingInput(
	draft: WineSightingDraft,
): CreateEntrySightingInput | undefined {
	const memo = draft.memo.trim();
	const price = toIntOrUndefined(draft.price);
	const place = placePayload(draft, {});
	const input = {
		...place,
		...(draft.seenOn ? { seenOn: draft.seenOn } : {}),
		...(price != null ? { price } : {}),
		...(memo ? { memo } : {}),
	};
	return Object.keys(input).length > 0 ? input : undefined;
}

/**
 * 更新時の入力。空欄は null(クリア)として送る。
 *
 * batchId / photoIndex / photoIndexes は**送らない**。由来(どの一括登録のどの写真か)はユーザが
 * 編集する情報ではなく、未指定なら drizzle が列を触らないので値が保たれる。
 *
 * 場所を新規作成するときは `placeId` を送らず `newPlace` だけを送る(サーバが採番した
 * 新しい id が入る)。両方送るとサーバの zod が排他違反で弾く。
 */
export function buildUpdateSightingInput(
	id: string,
	draft: WineSightingDraft,
): UpdateWineSightingInput {
	const memo = draft.memo.trim();
	return {
		id,
		...placePayload(draft, { placeId: null }),
		seenOn: draft.seenOn || null,
		price: toIntOrUndefined(draft.price) ?? null,
		memo: memo || null,
	};
}
