import { createServerFn } from "@tanstack/react-start";
import * as dashboardService from "#/lib/services/dashboard-service";
import { authMiddleware } from "./middleware";

// ログイン後トップページのダッシュボードRPC。学習状況はユーザ固有データなので
// authMiddleware で認証必須。集計ロジックはサービス層に委譲する。

export const getDashboard = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) => dashboardService.getDashboard(context.user.id));
