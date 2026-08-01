import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AI_MAX_QUESTION_CHARS, chatHistorySchema } from "#/lib/ai/config";
import * as aiService from "#/lib/services/ai-service";
import { authMiddleware } from "./middleware";

// 地域チャットQ&AのRPC。Workers AI で回答し、実測トークンでクレジットを消費する。認証必須。
// 会話履歴はクライアントが保持し毎ターン渡す(サーバはステートレス)。
// 使うモデルはユーザのプロフィール設定(preferredAiModel)からサーバ側で解決するため、
// リクエストでは受け取らない。
export const askRegion = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			regionId: z.string().min(1),
			aopId: z.string().min(1).optional(),
			question: z.string().trim().min(1).max(AI_MAX_QUESTION_CHARS),
			// 境界の定義はドメイン lib と共有する(MCP 層と食い違わせない。#340)
			history: chatHistorySchema.optional(),
		}),
	)
	.handler(({ data, context }) =>
		aiService.answerRegionQuestion(context.user.id, data),
	);

/**
 * 写真からの一括登録(Issue #358)が使える環境か。この経路は Claude 専用で
 * フォールバックを持たないため、`ANTHROPIC_API_KEY` が無い環境では**導線ごと隠す**。
 * 判定の実体は ai-service 側と同じ関数で、UI の出し分けとサーバの 503 が
 * 食い違わないようにする。
 */
export const getWineListAnalysisAvailability = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(() => ({ available: aiService.isWineListAnalysisAvailable() }));
