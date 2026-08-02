import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CELLAR_FILTER_IDS } from "#/lib/drunk-wine/filter";
import { DRUNK_WINE_MAX_PAGE_SIZE } from "#/lib/drunk-wine/pagination";
import {
	createDrunkWineInput,
	drunkWineFields,
	updateDrunkWineInput,
	updateWineTastingInput,
	wineTastingFields,
} from "#/lib/drunk-wine/schema";
import {
	updateWineSightingInput,
	wineSightingFields,
} from "#/lib/place/schema";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import { authMiddleware } from "./middleware";

// マイセラーのRPC。全てユーザ固有データなので認証必須。
// 写真アップロードはバイナリを扱うため server fn ではなく
// /api/wine-photos (FormData) で行う。

const entryId = z.string().min(1).max(80);

export const createDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(createDrunkWineInput)
	.handler(({ data, context }) =>
		drunkWineService.createDrunkWine(context.user.id, data),
	);

export const updateDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(updateDrunkWineInput)
	.handler(({ data, context }) =>
		drunkWineService.updateDrunkWine(context.user.id, data),
	);

export const deleteDrunkWine = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.deleteDrunkWine(context.user.id, data.id),
	);

// 一覧のチェックボックス選択からのまとめ削除(Issue #363 案B)。上限は一覧の
// 1回の取得上限(DRUNK_WINE_MAX_PAGE_SIZE)に合わせる(それ以上選ばせるUIが無い)。
export const deleteDrunkWines = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			ids: z.array(entryId).min(1).max(DRUNK_WINE_MAX_PAGE_SIZE),
		}),
	)
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

// ---- 飲用記録 -------------------------------------------------------------

export const listWineTastings = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ drunkWineId: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.listWineTastings(context.user.id, data.drunkWineId),
	);

export const addWineTasting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ drunkWineId: entryId, ...wineTastingFields }))
	.handler(({ data, context }) => {
		const { drunkWineId, ...tasting } = data;
		return drunkWineService.addWineTasting(
			context.user.id,
			drunkWineId,
			tasting,
		);
	});

export const updateWineTasting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(updateWineTastingInput)
	.handler(({ data, context }) =>
		drunkWineService.updateWineTasting(context.user.id, data),
	);

export const deleteWineTasting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.deleteWineTasting(context.user.id, data.id),
	);

/** 「飲んだ」ボタン。飲用記録の追加と status='finished' を1操作で行う。 */
export const markWineDrunk = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId, ...wineTastingFields }))
	.handler(({ data, context }) => {
		const { id, ...tasting } = data;
		return drunkWineService.markWineDrunk(context.user.id, id, tasting);
	});

// ---- 目撃記録(Issue #358) -------------------------------------------------
// 飲用記録と同じ形のRPC。場所・バッチIDの所有権はサービス層が確認する。

export const listWineSightings = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ drunkWineId: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.listWineSightings(context.user.id, data.drunkWineId),
	);

export const addWineSighting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ drunkWineId: entryId, ...wineSightingFields }))
	.handler(({ data, context }) => {
		const { drunkWineId, ...sighting } = data;
		return drunkWineService.addWineSighting(
			context.user.id,
			drunkWineId,
			sighting,
		);
	});

export const updateWineSighting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(updateWineSightingInput)
	.handler(({ data, context }) =>
		drunkWineService.updateWineSighting(context.user.id, data),
	);

export const deleteWineSighting = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: entryId }))
	.handler(({ data, context }) =>
		drunkWineService.deleteWineSighting(context.user.id, data.id),
	);
