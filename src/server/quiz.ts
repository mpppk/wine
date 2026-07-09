import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { QUIZ_TYPE_IDS } from "#/lib/quiz/types";
import * as quizService from "#/lib/services/quiz-service";
import { REGION_IDS } from "#/lib/wine/regions";
import { authMiddleware } from "./middleware";

// クイズのRPC。認証必須のユーザ固有APIなので、公開JSONのAPIルートではなく
// authMiddleware 付きの server function にする。正解・解説込みの生成済み問題を
// 返す(学習アプリなのでアンチチートは不要、即時フィードバックを優先)。

// 地域は REGIONS から導出(新地域が自動で対象になる)
const REGION_ID_SCHEMA = z.enum(REGION_IDS);

const getNextQuestionsInput = z.object({
	regionId: REGION_ID_SCHEMA,
	quizTypes: z.array(z.enum(QUIZ_TYPE_IDS)).min(1),
	count: z.number().int().min(1).max(10).default(5),
	excludeKeys: z.array(z.string().max(120)).max(50).default([]),
});

export const getNextQuestions = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(getNextQuestionsInput)
	.handler(({ data, context }) =>
		quizService.getNextQuestions(context.user.id, data),
	);

const recordAnswerInput = z.object({
	questionKey: z.string().max(120),
	wasCorrect: z.boolean(),
});

export const recordAnswer = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(recordAnswerInput)
	.handler(({ data, context }) =>
		quizService.recordAnswer(context.user.id, data),
	);

export const getQuizProgress = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) => quizService.getProgress(context.user.id));
