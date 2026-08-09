import {
	NEW_PLACE_VALUE,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import type {
	CreateEntrySightingInput,
	CreateWineSightingInput,
	UpdateWineSightingInput,
} from "#/lib/place/schema";
import type { WineSightingEntry } from "#/lib/services/drunk-wine-service";

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

/** 数値入力(文字列)を整数に寄せる。空・数値化できない値は undefined。 */
function toIntOrUndefined(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 追加時の入力。空欄のフィールドは送らない(= サーバ側で null になる)。
 *
 * 新規作成の場所は扱わない(この経路は `allowNewPlace` を開いていないので、
 * `placeId` が NEW_PLACE_VALUE になることは無い)。
 */
export function buildAddSightingInput(
	draft: WineSightingDraft,
): CreateWineSightingInput {
	const memo = draft.memo.trim();
	return {
		...(draft.placeId ? { placeId: draft.placeId } : {}),
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
	const newPlaceName = draft.newPlaceName.trim();
	const creatingPlace = draft.placeId === NEW_PLACE_VALUE;
	const price = toIntOrUndefined(draft.price);
	const place = creatingPlace
		? newPlaceName
			? { newPlace: { name: newPlaceName } }
			: {}
		: draft.placeId
			? { placeId: draft.placeId }
			: {};
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
 * batchId / photoIndex は**送らない**。由来(どの一括登録のどの写真か)はユーザが
 * 編集する情報ではなく、未指定なら drizzle が列を触らないので値が保たれる。
 */
export function buildUpdateSightingInput(
	id: string,
	draft: WineSightingDraft,
): UpdateWineSightingInput {
	const memo = draft.memo.trim();
	return {
		id,
		placeId: draft.placeId || null,
		seenOn: draft.seenOn || null,
		price: toIntOrUndefined(draft.price) ?? null,
		memo: memo || null,
	};
}
