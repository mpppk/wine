import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	createDrunkWineInput,
	updateDrunkWineInput,
} from "#/lib/drunk-wine/schema";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import { authMiddleware } from "./middleware";

// マイセラー(飲んだワイン)のRPC。全てユーザ固有データなので認証必須。
// 写真アップロードはバイナリを扱うため server fn ではなく
// /api/wine-photos (FormData) で行う。

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
	.inputValidator(z.object({ id: z.string().min(1).max(80) }))
	.handler(({ data, context }) =>
		drunkWineService.deleteDrunkWine(context.user.id, data.id),
	);

export const listDrunkWines = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) => drunkWineService.listDrunkWines(context.user.id));

export const getDrunkWine = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ id: z.string().min(1).max(80) }))
	.handler(({ data, context }) =>
		drunkWineService.getDrunkWine(context.user.id, data.id),
	);
