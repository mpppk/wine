import { z } from "zod";
import { AI_WINE_LIST_MAX_WINES } from "#/lib/ai/config";
import { calendarDateSchema } from "#/lib/date/calendar-date";
import {
	createWineTastingInput,
	drunkWineFields,
} from "#/lib/drunk-wine/schema";
import {
	createPlaceInput,
	MAX_PHOTOS_PER_IMPORT_BATCH,
	wineSightingFields,
} from "#/lib/place/schema";

// 写真からの一括登録(Issue #358)の入力バリデーション。1回の確定で
// 場所(新規なら)・バッチ・銘柄・目撃記録・飲用記録をまとめて作るため、
// 入力もその単位で受け取る。ランタイム依存を持たない純粋な zod パーツに保つ
// (drunk-wine/schema.ts・place/schema.ts と同じ方針)。

/**
 * 1回の一括登録で作れる銘柄の上限。解析側の件数上限(AI_WINE_LIST_MAX_WINES)と
 * 同じ値にする——レビュー画面に出せた候補は全部登録できる、が期待される挙動で、
 * ここが小さいと「解析はできたのに登録で弾かれる」袋小路になる。
 */
export const MAX_ITEMS_PER_IMPORT = AI_WINE_LIST_MAX_WINES;

/** 新規作成する銘柄の属性(飲用記録は item.tasting 側で受ける)。 */
export const importWineInput = z.object(drunkWineFields);

/**
 * 銘柄1件ぶんの登録指示。
 *
 * `existingId`(既存エントリに目撃を足す)と `wine`(新規作成)は**排他で、
 * どちらか一方が必須**。レビュー画面の「既存『シャブリ 2020』に目撃を追加」と
 * 「新規登録」の2択がそのままこの形になる。
 */
export const importItemInput = z
	.object({
		/** 既存エントリのID。指定時は銘柄を作らず目撃記録だけを足す */
		existingId: z.string().min(1).max(80).optional(),
		/** 新規作成する銘柄。existingId と排他 */
		wine: importWineInput.optional(),
		/**
		 * 目撃記録の銘柄ごとの属性。場所・見かけた日・バッチIDはバッチ共通なので
		 * ここには含めない(サーバが埋める。クライアントに繰り返させない)。
		 */
		sighting: z
			.object({
				photoIndex: wineSightingFields.photoIndex,
				price: wineSightingFields.price,
				memo: wineSightingFields.memo,
			})
			.optional(),
		/** 「飲んだ」トグルで入力された飲用記録。未指定なら作らない */
		tasting: createWineTastingInput.optional(),
	})
	.refine((v) => !!v.existingId !== !!v.wine, {
		error: "既存エントリの指定と新規銘柄はどちらか一方を指定してください",
	});

/**
 * 一括登録の入力。
 *
 * `photoCount` は**これから `/api/import-batch-photos` へ送る写真の枚数**で、
 * 実体のアップロードは batchId が決まってからの2段階目になる(R2キーが batchId 依存)。
 * 枚数を先に受けるのは、`sighting.photoIndex` が枚数の範囲に収まっているかを
 * 登録時点で検証するため——後段のアップロードが失敗しても、目撃記録が存在しない
 * 写真を指したままにはしない。
 */
export const bulkRegisterFromScanInput = z
	.object({
		/** 既存の場所を選んだ場合のID */
		placeId: z.string().min(1).max(80).optional(),
		/** その場で新規作成する場所。placeId と排他 */
		newPlace: createPlaceInput.optional(),
		/** 見かけた日。バッチ内の全目撃記録の既定値になる */
		seenOn: calendarDateSchema.optional(),
		/** 後段でアップロードする写真の枚数 */
		photoCount: z.number().int().min(0).max(MAX_PHOTOS_PER_IMPORT_BATCH),
		items: z.array(importItemInput).min(1).max(MAX_ITEMS_PER_IMPORT),
	})
	.refine((v) => !(v.placeId && v.newPlace), {
		error: "場所は既存の選択か新規作成のどちらか一方にしてください",
	});

export type ImportItemInput = z.infer<typeof importItemInput>;
export type BulkRegisterFromScanInput = z.infer<
	typeof bulkRegisterFromScanInput
>;
