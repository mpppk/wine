import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AI_MAX_QUESTION_CHARS, REGION_QA_MODEL_KEYS } from "#/lib/ai/config";
import * as aiService from "#/lib/services/ai-service";
import { authMiddleware } from "./middleware";

// 地域チャットQ&AのRPC。Workers AI で回答し、実測トークンでクレジットを消費する。認証必須。
// 会話履歴はクライアントが保持し毎ターン渡す(サーバはステートレス)。
export const askRegion = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			regionId: z.string().min(1),
			aopId: z.string().min(1).optional(),
			question: z.string().trim().min(1).max(AI_MAX_QUESTION_CHARS),
			history: z
				.array(
					z.object({
						role: z.enum(["user", "assistant"]),
						content: z.string().min(1).max(4000),
					}),
				)
				.max(20)
				.optional(),
			model: z.enum(REGION_QA_MODEL_KEYS).optional(),
		}),
	)
	.handler(({ data, context }) =>
		aiService.answerRegionQuestion(context.user.id, data),
	);
