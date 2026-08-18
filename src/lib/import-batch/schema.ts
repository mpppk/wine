import { z } from "zod";
import { AI_WINE_LIST_MAX_WINES } from "#/lib/ai/config";
import { calendarDateSchema } from "#/lib/date/calendar-date";
import {
	createWineTastingInput,
	drunkWineFields,
	NOTE_MAX,
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
const MAX_ITEMS_PER_IMPORT = AI_WINE_LIST_MAX_WINES;

/**
 * 1回の一括登録で web から取りに行く銘柄写真の上限(#473)。
 *
 * 件数上限(80銘柄)ぶん全部を取りに行くと、登録の確定が外部サイトの応答時間 × 80 に
 * 引きずられ、Workers のサブリクエスト数にも触れる。上限を超えたぶんは web 画像を諦めて
 * 一括登録の写真へ退避する(要件の3段目)ので、**登録そのものは必ず成立する**。
 */
export const MAX_WEB_PHOTOS_PER_IMPORT = 20;

/** 取り込む画像URLの長さ上限。クエリ付きのCDN URLでも収まる長さ。 */
const WEB_PHOTO_URL_MAX = 2048;

/** 新規作成する銘柄の属性(飲用記録は item.tasting 側で受ける)。 */
const importWineInput = z.object(drunkWineFields);

/**
 * 銘柄1件ぶんの登録指示。
 *
 * `existingId`(既存エントリに目撃を足す)と `wine`(新規作成)は**排他で、
 * どちらか一方が必須**。レビュー画面の「既存『シャブリ 2020』に目撃を追加」と
 * 「新規登録」の2択がそのままこの形になる。
 */
const importItemInput = z
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
		/**
		 * web から取り込む銘柄写真(#473)。解析が「手元の写真にこの1本だけを写した
		 * 適切な写真が無い」と判断した銘柄にだけ付く。
		 *
		 * **新規作成(`wine`)のときだけ意味を持つ**。既存エントリへの目撃追加では
		 * 無視する——そのエントリは既に自分の写真を持っている(か、持たないことを
		 * ユーザが選んでいる)ので、一括登録が勝手に足すものではない。
		 *
		 * 取得先の検証(https のみ・実バイトのMIME判定・サイズ上限)はサーバの
		 * `fetchRemotePhoto` が単一の関門として行う。ここは形の検証だけ。
		 */
		webPhoto: z
			.object({
				url: z.string().min(1).max(WEB_PHOTO_URL_MAX),
				/** 画像と実物のズレ(ヴィンテージ違い等)。取り込めたときだけコメントへ追記する */
				note: z.string().max(NOTE_MAX).optional(),
			})
			.optional(),
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
	})
	// 目撃記録が「存在しない写真」を指したまま残らないよう、枚数との整合をここで見る。
	// wineSightingFields.photoIndex 単体では上限(10枚)しか見られない。
	.refine(
		(v) =>
			v.items.every(
				(i) =>
					i.sighting?.photoIndex == null ||
					i.sighting.photoIndex < v.photoCount,
			),
		{ error: "写真の番号が、送信する写真の枚数を超えています" },
	);

export type BulkRegisterFromScanInput = z.infer<
	typeof bulkRegisterFromScanInput
>;
