import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as adminService from "#/lib/services/admin-service";
import { adminMiddleware } from "./middleware";

// 管理画面(ユーザ管理)のRPC。すべて adminMiddleware で role="admin" のみに制限する。

/** ユーザ一覧を検索・ページングして返す。管理者限定。 */
export const adminListUsers = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			q: z.string().trim().max(200).optional(),
			page: z.number().int().min(1).max(10_000).default(1),
		}),
	)
	.handler(({ data }) => adminService.listUsers(data));

/** ユーザ詳細(基本情報・サブスク・クレジット・クーポン履歴)を返す。管理者限定。 */
export const adminGetUserDetail = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.inputValidator(z.object({ userId: z.string().min(1).max(100) }))
	.handler(({ data }) => adminService.getUserDetail(data.userId));
