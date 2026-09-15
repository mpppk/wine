import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CELLAR_FILTER_IDS } from "#/lib/drunk-wine/filter";
import { DRUNK_WINE_MAX_PAGE_SIZE } from "#/lib/drunk-wine/pagination";
import { drunkWineReferenceInputs } from "#/lib/drunk-wine/reference-inputs";
import {
	deleteDrunkWinesInput,
	drunkWineFields,
	entryIdSchema,
	updateDrunkWineInput,
	wineTastingFields,
} from "#/lib/drunk-wine/schema";
import {
	createDrunkWineWithSightingInput,
	createWineEncounterInput,
	updateWineEncounterInput,
} from "#/lib/place/schema";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import { authMiddleware } from "./middleware";

// マイセラーのRPC。全てユーザ固有データなので認証必須。
// 写真アップロードはバイナリを扱うため server fn ではなく
// /api/wine-photos (FormData) で行う。

const entryId = entryIdSchema;

// 作成は銘柄・飲用記録・目撃記録を1リクエストで受ける(#495)。写真から登録した回の
// 「見かけた場所・見かけた日」が、記録フォームへ切り替えた時点で捨てられていた。
export const createDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(createDrunkWineWithSightingInput)
	.handler(({ data, context }) =>
		drunkWineService.createDrunkWine(context.user.id, data),
	);

export const updateDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	// 解析の参考サイト・市場価格。指定されたときだけ置き換える(未指定は変更しない)。
	// 空配列で「取得済みを消す」こともできる。形の定義は `drunkWineReferenceInputs`。
	.inputValidator(updateDrunkWineInput.extend(drunkWineReferenceInputs))
	.handler(({ data, context }) =>
		drunkWineService.updateDrunkWine(context.user.id, data),
	);

export const deleteDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.deleteDrunkWine(context.user.id, data.id),
	);

// 一覧のチェックボックス選択からのまとめ削除(Issue #363 案B)。上限(BULK_DELETE_MAX)は
// 1リクエストの大きさの歯止めで、これを超える選択はクライアントが分割して送る(#400)。
export const deleteDrunkWines = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(deleteDrunkWinesInput)
	.handler(({ data, context }) =>
		drunkWineService.deleteDrunkWines(context.user.id, data.ids),
	);

// 一覧はページネーション付き(#254)。地図は全ピンが要るので limit を渡さない。
export const listDrunkWines = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(
		z
			.object({
				filter: z.enum(CELLAR_FILTER_IDS).optional(),
				limit: z.number().int().min(1).max(DRUNK_WINE_MAX_PAGE_SIZE).optional(),
				cursor: z.string().max(200).nullish(),
			})
			.optional(),
	)
	.handler(({ data, context }) =>
		drunkWineService.listDrunkWines(context.user.id, data ?? {}),
	);

/**
 * 地図の情報パネル(AopDetailPanel)の「マイセラー」欄。表示中のAOPを紐付けた
 * 自分の登録を引く。aopId の完全一致で、件数はAOP単位なのでページングしない。
 */
export const listDrunkWinesByAop = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ aopId: drunkWineFields.aopId.unwrap() }))
	.handler(({ data, context }) =>
		drunkWineService.listDrunkWinesByAop(context.user.id, data.aopId),
	);

/**
 * 一覧チップの件数。ページに載っていない行も数えるので集計だけを引く(#254)。
 * 場所で絞り込んでいるときは同じ母集合で数える(チップと一覧の食い違いを防ぐ)。
 */
export const countCellarFilters = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({ placeId: z.string().min(1).max(80).optional() }).optional(),
	)
	.handler(({ data, context }) =>
		drunkWineService.countCellarFilters(context.user.id, data ?? {}),
	);

export const getDrunkWine = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.getDrunkWine(context.user.id, data.id),
	);

// ---- 体験記録(Issue #606) -------------------------------------------------
// 「そのワインに出会った1回」が1行で、飲んだかどうかは drank で表す。
// 旧2テーブル体制の list/add/update/deleteWineTasting・list/add/update/
// deleteWineSighting は PR2 で UI とともに廃止し、サービス層の互換アダプタ
// (MCP 用)だけを残す。

export const listWineEncounters = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ drunkWineId: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.listWineEncounters(context.user.id, data.drunkWineId),
	);

export const addWineEncounter = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	// 場所の新規作成(newPlace)も受ける。placeId との排他は
	// createWineEncounterInput の refine が持つ。
	.inputValidator(createWineEncounterInput.extend({ drunkWineId: entryId }))
	.handler(({ data, context }) => {
		const { drunkWineId, ...encounter } = data;
		return drunkWineService.addWineEncounter(
			context.user.id,
			drunkWineId,
			encounter,
		);
	});

export const updateWineEncounter = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(updateWineEncounterInput)
	.handler(({ data, context }) =>
		drunkWineService.updateWineEncounter(context.user.id, data),
	);

export const deleteWineEncounter = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.deleteWineEncounter(context.user.id, data.id),
	);

/** 「飲んだ」ボタン。飲用記録の追加と status='finished' を1操作で行う。 */
export const markWineDrunk = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId, ...wineTastingFields }))
	.handler(({ data, context }) => {
		const { id, ...tasting } = data;
		return drunkWineService.markWineDrunk(context.user.id, id, tasting);
	});
