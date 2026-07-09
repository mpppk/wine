import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { quizQuestionStat } from "#/db/schema";
import {
	candidateCountsByType,
	getQuestionKeyInfo,
	listCandidates,
	materializeQuestion,
} from "#/lib/quiz/generators";
import { pickQuestionKeys, type QuestionStatLike } from "#/lib/quiz/scheduler";
import type { QuizQuestion, QuizType } from "#/lib/quiz/types";
import { listRegions } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// クイズのユーザ状態(解答実績)を扱うサービス層。問題生成・スケジューリングの
// ロジックは #/lib/quiz の純関数に置き、ここはD1アクセスとの薄い橋渡しに徹する。

export interface GetNextQuestionsOptions {
	regionId: RegionId;
	quizTypes: QuizType[];
	count: number;
	/** クライアントが未消化のキュー等、出題から除外するキー */
	excludeKeys: string[];
}

export async function getNextQuestions(
	userId: string,
	options: GetNextQuestionsOptions,
): Promise<{ questions: QuizQuestion[] }> {
	const { regionId, quizTypes, count, excludeKeys } = options;
	const candidates = listCandidates(regionId, quizTypes);
	if (candidates.length === 0) return { questions: [] };

	const rows = await db
		.select({
			questionKey: quizQuestionStat.questionKey,
			correctCount: quizQuestionStat.correctCount,
			incorrectCount: quizQuestionStat.incorrectCount,
			streak: quizQuestionStat.streak,
			lastAnsweredAt: quizQuestionStat.lastAnsweredAt,
		})
		.from(quizQuestionStat)
		.where(
			and(
				eq(quizQuestionStat.userId, userId),
				eq(quizQuestionStat.regionId, regionId),
			),
		);
	const statsByKey = new Map<string, QuestionStatLike>(
		rows.map((row) => [
			row.questionKey,
			{
				correctCount: row.correctCount,
				incorrectCount: row.incorrectCount,
				streak: row.streak,
				lastAnsweredAt: row.lastAnsweredAt.getTime(),
			},
		]),
	);

	const now = Date.now();
	const questions: QuizQuestion[] = [];
	const used = new Set(excludeKeys);
	// materialize がデータ失効等で null を返した場合に備えて1回だけ補充する
	for (let attempt = 0; attempt < 2 && questions.length < count; attempt++) {
		const keys = pickQuestionKeys({
			candidates,
			statsByKey,
			count: count - questions.length,
			excludeKeys: [...used],
			now,
			rng: Math.random,
		});
		if (keys.length === 0) break;
		for (const key of keys) {
			used.add(key);
			const question = materializeQuestion(key, Math.random);
			if (question) questions.push(question);
		}
	}
	return { questions };
}

export interface RecordAnswerOptions {
	questionKey: string;
	wasCorrect: boolean;
}

export async function recordAnswer(
	userId: string,
	options: RecordAnswerOptions,
): Promise<void> {
	const { questionKey, wasCorrect } = options;
	// クライアント申告の形式・地域は信用せず、キーから導出・検証する
	const info = getQuestionKeyInfo(questionKey);
	if (!info) {
		throw new Error(`invalid question key: ${questionKey}`);
	}
	const now = new Date();
	await db
		.insert(quizQuestionStat)
		.values({
			userId,
			questionKey,
			quizType: info.quizType,
			regionId: info.regionId,
			correctCount: wasCorrect ? 1 : 0,
			incorrectCount: wasCorrect ? 0 : 1,
			streak: wasCorrect ? 1 : 0,
			lastAnsweredAt: now,
			lastCorrectAt: wasCorrect ? now : null,
		})
		.onConflictDoUpdate({
			target: [quizQuestionStat.userId, quizQuestionStat.questionKey],
			set: {
				correctCount: sql`${quizQuestionStat.correctCount} + ${wasCorrect ? 1 : 0}`,
				incorrectCount: sql`${quizQuestionStat.incorrectCount} + ${wasCorrect ? 0 : 1}`,
				streak: wasCorrect ? sql`${quizQuestionStat.streak} + 1` : 0,
				lastAnsweredAt: now,
				updatedAt: now,
				...(wasCorrect ? { lastCorrectAt: now } : {}),
			},
		});
}

export interface QuizTypeProgress {
	quizType: QuizType;
	/** 現データから生成できる問題数 */
	candidateCount: number;
	/** 一度でも解いた問題数 */
	seenCount: number;
	/** 延べ解答数 */
	answerCount: number;
	/** 延べ正解数 */
	correctCount: number;
	/** 苦手(解いたが直近で不正解 = streak 0)の問題数 */
	weakCount: number;
	/** 習得済み(2連続以上正解)の問題数 */
	masteredCount: number;
}

export interface RegionProgress {
	regionId: RegionId;
	quizTypes: QuizTypeProgress[];
}

export async function getProgress(
	userId: string,
): Promise<{ regions: RegionProgress[] }> {
	const rows = await db
		.select({
			regionId: quizQuestionStat.regionId,
			quizType: quizQuestionStat.quizType,
			seenCount: sql<number>`count(*)`,
			answerCount: sql<number>`sum(${quizQuestionStat.correctCount} + ${quizQuestionStat.incorrectCount})`,
			correctCount: sql<number>`sum(${quizQuestionStat.correctCount})`,
			weakCount: sql<number>`sum(case when ${quizQuestionStat.streak} = 0 then 1 else 0 end)`,
			masteredCount: sql<number>`sum(case when ${quizQuestionStat.streak} >= 2 then 1 else 0 end)`,
		})
		.from(quizQuestionStat)
		.where(eq(quizQuestionStat.userId, userId))
		.groupBy(quizQuestionStat.regionId, quizQuestionStat.quizType);
	const byRegionAndType = new Map(
		rows.map((row) => [`${row.regionId}:${row.quizType}`, row]),
	);

	const regions = listRegions()
		.filter((r) => r.enabled)
		.map((region) => {
			const counts = candidateCountsByType(region.id as RegionId);
			const quizTypes = (Object.entries(counts) as [QuizType, number][]).map(
				([quizType, candidateCount]) => {
					const row = byRegionAndType.get(`${region.id}:${quizType}`);
					return {
						quizType,
						candidateCount,
						seenCount: row?.seenCount ?? 0,
						answerCount: row?.answerCount ?? 0,
						correctCount: row?.correctCount ?? 0,
						weakCount: row?.weakCount ?? 0,
						masteredCount: row?.masteredCount ?? 0,
					};
				},
			);
			return { regionId: region.id as RegionId, quizTypes };
		});
	return { regions };
}
