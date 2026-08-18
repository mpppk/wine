import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bulkRegisterFromScanInput } from "#/lib/import-batch/schema";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import * as placeService from "#/lib/services/place-service";
import { authMiddleware } from "./middleware";

// 場所(place)と写真からの一括登録のRPC。いずれもユーザ固有データなので認証必須。
// バッチ写真のアップロードはバイナリを扱うため server fn ではなく
// /api/import-batch-photos (FormData) で行う(マイセラーの写真と同じ流儀)。

export const listPlaces = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) => placeService.listPlaces(context.user.id));

/**
 * 写真からの一括登録の確定。場所(新規なら)・バッチ・銘柄・目撃記録・飲用記録を
 * 1回の db.batch で原子的に作る。写真の実体は戻り値の batchId を使って
 * /api/import-batch-photos へ送る(2段階目)。
 */
export const bulkRegisterFromScan = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(bulkRegisterFromScanInput)
	.handler(({ data, context }) =>
		drunkWineService.bulkRegisterFromScan(context.user.id, data),
	);

/**
 * 一括登録バッチの取り消し(Issue #363 案A)。`/cellar/import` の登録完了直後に加えて、
 * **一括登録の履歴画面(#385)からも恒常的に呼ばれる**。編集済みエントリの扱いは
 * 未決の論点で、警告はクライアント側の確認ダイアログに委ねている(サービス層のJSDoc参照)。
 */
export const undoImportBatch = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ batchId: z.string().min(1).max(80) }))
	.handler(({ data, context }) =>
		drunkWineService.undoImportBatch(context.user.id, data.batchId),
	);

/**
 * 過去の一括登録バッチ履歴の一覧(Issue #380)。`/cellar/import/history` から使う。
 */
export const listImportBatches = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) =>
		drunkWineService.listImportBatches(context.user.id),
	);

/**
 * 一括登録バッチ1件の取得(Issue #427)。履歴からの再解析で、保存済みの写真URLと
 * 当時の場所・見かけた日を読み直すために `/cellar/new` のローダーが呼ぶ。
 */
export const getImportBatch = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ batchId: z.string().min(1).max(80) }))
	.handler(({ data, context }) =>
		drunkWineService.getImportBatch(context.user.id, data.batchId),
	);
