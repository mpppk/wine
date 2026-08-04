import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as oauthClientService from "#/lib/services/oauth-client-service";
import { authMiddleware } from "./middleware";

// 同意画面(/oauth/consent)がクライアント情報を引くための RPC(#399)。
//
// 認証必須にしてある。同意画面は必ずログイン後に到達する(better-auth の mcp プラグインが
// 未ログインなら loginPage へ飛ばす)ので通常利用は妨げず、**登録済みクライアントの
// 一覧を未認証で舐められる経路を作らない**ためにこの側へ倒す。

const clientSummaryInput = z.object({ clientId: z.string().min(1).max(255) });

export const getOAuthClientSummary = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(clientSummaryInput)
	.handler(({ data }) =>
		oauthClientService.getOAuthClientSummary(data.clientId),
	);
