import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { quizQuestionStat } from "#/db/schema";
import {
	candidateCountsByAopId,
	candidateCountsByType,
	getQuestionKeyInfo,
	listCandidates,
	materializeQuestion,
} from "#/lib/quiz/generators";
import { parseKey } from "#/lib/quiz/keys";
import {
	filterUnsolved,
	pickQuestionKeys,
	type QuestionStatLike,
} from "#/lib/quiz/scheduler";
import { listScopedCandidates } from "#/lib/quiz/scope";
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
	/**
	 * 指定時は選択AOPとその階層近傍(親の村・配下の畑)の問題に絞る。
	 * クライアント申告のID列は信用せず、slug 1つからサーバ側で展開する
	 */
	scopeAopId?: string;
}

export interface GetNextQuestionsResult {
	questions: QuizQuestion[];
	/** まだ一度も正解していない候補数(スコープ内)。残り未正解数の表示・完了判定に使う */
	remaining: number;
	/** スコープ内の全候補数(正解済みも含む)。「問題0件」と「全問正解済み」の区別に使う */
	total: number;
}

export async function getNextQuestions(
	// null = 未ログイン。実績が無いので全問未出題としてスケジューリングされる
	userId: string | null,
	options: GetNextQuestionsOptions,
): Promise<GetNextQuestionsResult> {
	const { regionId, quizTypes, count, excludeKeys, scopeAopId } = options;
	const candidates =
		scopeAopId !== undefined
			? listScopedCandidates(regionId, quizTypes, scopeAopId)
			: listCandidates(regionId, quizTypes);
	if (candidates === null) {
		throw new Error(`invalid scope aop: ${scopeAopId}`);
	}
	if (candidates.length === 0) return { questions: [], remaining: 0, total: 0 };

	const rows = userId
		? await db
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
				)
		: [];
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

	// 「全問正解で終了」: まだ一度も正解していない問題だけを出題対象にする。
	// 正解済み(correctCount>0)は永続的に除外し、残り未正解数を算出する。
	const unsolved = filterUnsolved(candidates, statsByKey);

	const now = Date.now();
	const questions: QuizQuestion[] = [];
	const used = new Set(excludeKeys);
	// materialize がデータ失効等で null を返した場合に備えて1回だけ補充する
	for (let attempt = 0; attempt < 2 && questions.length < count; attempt++) {
		const keys = pickQuestionKeys({
			candidates: unsolved,
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
	return { questions, remaining: unsolved.length, total: candidates.length };
}

export interface RecordAnswerOptions {
	questionKey: string;
	wasCorrect: boolean;
}

/**
 * 記録直前の行スナップショット。リセット(revertAnswer)で回答前へ完全復元するために
 * recordAnswer が返す。streak やタイムスタンプは単純なデクリメントでは戻せないため、
 * 更新前の値そのものを保持する。タイムスタンプは epoch ms。
 */
export interface AnswerSnapshot {
	existed: boolean;
	correctCount: number;
	incorrectCount: number;
	streak: number;
	lastAnsweredAt: number | null;
	lastCorrectAt: number | null;
}

export async function recordAnswer(
	userId: string,
	options: RecordAnswerOptions,
): Promise<AnswerSnapshot> {
	const { questionKey, wasCorrect } = options;
	// クライアント申告の形式・地域は信用せず、キーから導出・検証する
	const info = getQuestionKeyInfo(questionKey);
	if (!info) {
		throw new Error(`invalid question key: ${questionKey}`);
	}
	// 更新直前の行を控えておき、リセット時にこの値へ復元できるようにする
	const existing = await db
		.select({
			correctCount: quizQuestionStat.correctCount,
			incorrectCount: quizQuestionStat.incorrectCount,
			streak: quizQuestionStat.streak,
			lastAnsweredAt: quizQuestionStat.lastAnsweredAt,
			lastCorrectAt: quizQuestionStat.lastCorrectAt,
		})
		.from(quizQuestionStat)
		.where(
			and(
				eq(quizQuestionStat.userId, userId),
				eq(quizQuestionStat.questionKey, questionKey),
			),
		)
		.limit(1);
	const priorRow = existing[0];
	const snapshot: AnswerSnapshot = priorRow
		? {
				existed: true,
				correctCount: priorRow.correctCount,
				incorrectCount: priorRow.incorrectCount,
				streak: priorRow.streak,
				lastAnsweredAt: priorRow.lastAnsweredAt.getTime(),
				lastCorrectAt: priorRow.lastCorrectAt?.getTime() ?? null,
			}
		: {
				existed: false,
				correctCount: 0,
				incorrectCount: 0,
				streak: 0,
				lastAnsweredAt: null,
				lastCorrectAt: null,
			};

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
	return snapshot;
}

export interface RevertAnswerOptions {
	questionKey: string;
	prior: AnswerSnapshot;
}

/**
 * 直前の recordAnswer を取り消し、行を回答前の状態へ戻す(誤タップ救済)。
 * prior は recordAnswer が返したスナップショット。回答で新規作成された行は削除し、
 * 既存行は保持していた値へ復元する。復元対象は認証済みユーザ本人の行のみ。
 */
export async function revertAnswer(
	userId: string,
	options: RevertAnswerOptions,
): Promise<void> {
	const { questionKey, prior } = options;
	// キーの妥当性を検証(recordAnswer と同じ防御)
	const info = getQuestionKeyInfo(questionKey);
	if (!info) {
		throw new Error(`invalid question key: ${questionKey}`);
	}
	if (!prior.existed) {
		// 回答で初めて作られた行なので、丸ごと削除すれば回答前(未出題)に戻る
		await db
			.delete(quizQuestionStat)
			.where(
				and(
					eq(quizQuestionStat.userId, userId),
					eq(quizQuestionStat.questionKey, questionKey),
				),
			);
		return;
	}
	await db
		.update(quizQuestionStat)
		.set({
			correctCount: prior.correctCount,
			incorrectCount: prior.incorrectCount,
			streak: prior.streak,
			// existed=true の行は lastAnsweredAt が非null。型の都合でフォールバックを置く
			lastAnsweredAt:
				prior.lastAnsweredAt != null
					? new Date(prior.lastAnsweredAt)
					: new Date(),
			lastCorrectAt:
				prior.lastCorrectAt != null ? new Date(prior.lastCorrectAt) : null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(quizQuestionStat.userId, userId),
				eq(quizQuestionStat.questionKey, questionKey),
			),
		);
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

/**
 * 地図の進捗色分け用: 指定地域について、AOP(slug)ごとの学習済み率
 * (= 出題済み問題数 ÷ そのAOPの全候補問題数, 0〜1)を返す。
 * 問題キーの末尾セグメントが対象AOPのslugなので、キーをJS側で集計する
 * (AOP単位の集計列はDBに持たない)。出題済み(seen>0)のAOPのみを含める。
 */
export async function getAopSeenProgress(
	userId: string,
	regionId: RegionId,
): Promise<{ byAopId: Record<string, number> }> {
	const rows = await db
		.select({ questionKey: quizQuestionStat.questionKey })
		.from(quizQuestionStat)
		.where(
			and(
				eq(quizQuestionStat.userId, userId),
				eq(quizQuestionStat.regionId, regionId),
			),
		);

	// 1行=1キー=既出題1問。AOPごとに出題済み問題数を数える
	const seenByAopId = new Map<string, number>();
	for (const row of rows) {
		const parsed = parseKey(row.questionKey);
		if (!parsed) continue;
		seenByAopId.set(parsed.aopId, (seenByAopId.get(parsed.aopId) ?? 0) + 1);
	}

	const candidateCounts = candidateCountsByAopId(regionId);
	const byAopId: Record<string, number> = {};
	for (const [aopId, seen] of seenByAopId) {
		const candidate = candidateCounts.get(aopId);
		if (!candidate) continue; // 失効キー等、現データに候補が無いAOPは除外
		byAopId[aopId] = Math.min(1, seen / candidate);
	}
	return { byAopId };
}
