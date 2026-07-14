import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { QUIZ_TYPE_IDS } from "#/lib/quiz/types";
import * as quizService from "#/lib/services/quiz-service";
import { REGION_IDS } from "#/lib/wine/regions";
import { authMiddleware, optionalAuthMiddleware } from "./middleware";

// クイズのRPC。出題は未ログインでも可能(実績なしの全問未出題として扱う)だが、
// 解答の記録と進捗の取得はユーザ固有のデータなので authMiddleware で認証必須。
// 正解・解説込みの生成済み問題を返す(学習アプリなのでアンチチートは不要、
// 即時フィードバックを優先)。

// 地域は REGIONS から導出(新地域が自動で対象になる)
const REGION_ID_SCHEMA = z.enum(REGION_IDS);

const getNextQuestionsInput = z.object({
	regionId: REGION_ID_SCHEMA,
	quizTypes: z.array(z.enum(QUIZ_TYPE_IDS)).min(1),
	count: z.number().int().min(1).max(10).default(5),
	excludeKeys: z.array(z.string().max(120)).max(50).default([]),
	/** 指定時は選択AOPとその階層近傍に出題を絞る(展開はサーバ側で行う) */
	scopeAopId: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(80)
		.optional(),
});

export const getNextQuestions = createServerFn({ method: "GET" })
	.middleware([optionalAuthMiddleware])
	.inputValidator(getNextQuestionsInput)
	.handler(({ data, context }) =>
		quizService.getNextQuestions(context.user?.id ?? null, data),
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

// 直前の recordAnswer を取り消す(誤タップ救済)。prior は recordAnswer が返した
// 更新前スナップショット。userId はサーバの認証コンテキストから取り、本人の行のみ戻す
const revertAnswerInput = z.object({
	questionKey: z.string().max(120),
	prior: z.object({
		existed: z.boolean(),
		correctCount: z.number().int().min(0),
		incorrectCount: z.number().int().min(0),
		streak: z.number().int().min(0),
		lastAnsweredAt: z.number().int().nullable(),
		lastCorrectAt: z.number().int().nullable(),
		activityDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		activityWasCorrect: z.boolean(),
	}),
});

export const revertAnswer = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(revertAnswerInput)
	.handler(({ data, context }) =>
		quizService.revertAnswer(context.user.id, data),
	);

export const getQuizProgress = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(({ context }) => quizService.getProgress(context.user.id));

const getAopProgressInput = z.object({ regionId: REGION_ID_SCHEMA });

// 地図・リストの進捗表示用。AOP単位の正解進捗(solved/total)を返す。
// total は静的データ由来なので未ログインでも返せる(solved=0)。認証は任意。
export const getAopProgress = createServerFn({ method: "GET" })
	.middleware([optionalAuthMiddleware])
	.inputValidator(getAopProgressInput)
	.handler(({ data, context }) =>
		quizService.getAopSolvedProgress(context.user?.id ?? null, data.regionId),
	);
