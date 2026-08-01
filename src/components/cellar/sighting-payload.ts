import type { WineSightingDraft } from "#/components/cellar/SightingFields";
import type {
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

/** 追加時の入力。空欄のフィールドは送らない(= サーバ側で null になる)。 */
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
