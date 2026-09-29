import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	dailyActivity,
	quizPendingRevert,
	quizQuestionStat,
} from "#/db/schema";
import { jstDayKey } from "#/lib/dashboard/jst";
import { BadRequestError } from "#/lib/errors";
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
import {
	OUT_OF_SCOPE_QUIZ_TYPES,
	type QuizQuestion,
	type QuizType,
} from "#/lib/quiz/types";
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
	/**
	 * 再チャレンジモード。真のときは正解済み(correctCount>0)も除外せず全候補を
	 * 出題対象にする(「全問正解済みでも再挑戦したい」導線用)。実績は通常どおり
	 * 加算記録される(recordAnswer)。出題順は既存スケジューラの重み付けに従う。
	 */
	includeSolved?: boolean;
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
	const { regionId, quizTypes, count, excludeKeys, scopeAopId, includeSolved } =
		options;
	const candidates =
		scopeAopId !== undefined
			? listScopedCandidates(regionId, quizTypes, scopeAopId)
			: listCandidates(regionId, quizTypes);
	if (candidates === null) {
		// クライアント申告の scopeAopId が不正 = 入力エラー(400)。
		throw new BadRequestError(`invalid scope aop: ${scopeAopId}`);
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
	// 再チャレンジモード時は除外せず全候補を対象にする(正解済みも再挑戦できる)。
	const unsolved = includeSolved
		? candidates
		: filterUnsolved(candidates, statsByKey);

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
 * 記録直前の行スナップショット。revertAnswer で回答前へ完全復元するために
 * recordAnswer が返す。streak やタイムスタンプは単純なデクリメントでは戻せないため、
 * 更新前の値そのものを保持する。タイムスタンプは epoch ms。
 *
 * 互換のために残す: revertAnswer はサーバ側の quiz_pending_revert を使うため、
 * この値を送り返す必要は無い(クライアントは成功可否だけ見ればよい)。旧バンドルが
 * キャッシュされている間の取り消しを壊さないよう、返却自体は維持する。
 */
export interface AnswerSnapshot {
	existed: boolean;
	correctCount: number;
	incorrectCount: number;
	streak: number;
	lastAnsweredAt: number | null;
	lastCorrectAt: number | null;
	/** この解答を計上した日次集計の日(JST "YYYY-MM-DD")。revert時の減算対象 */
	activityDay: string;
	/** この解答が正解だったか。revert時に correctCount を戻すために保持 */
	activityWasCorrect: boolean;
}

type QuestionStatRow = {
	correctCount: number;
	incorrectCount: number;
	streak: number;
	lastAnsweredAt: Date;
	lastCorrectAt: Date | null;
};

/** recordAnswer の更新前スナップショット取得と revertAnswer の現在値確認で共有する */
async function fetchQuestionStatRow(
	userId: string,
	questionKey: string,
): Promise<QuestionStatRow | undefined> {
	const rows = await db
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
	return rows[0];
}

/** quiz_pending_revert の values/set で共有する回答前スナップショット由来の項目 */
function pendingRevertFields(
	priorRow: QuestionStatRow | undefined,
	questionKey: string,
	activityDay: string,
	wasCorrect: boolean,
) {
	return {
		questionKey,
		existed: !!priorRow,
		correctCount: priorRow?.correctCount ?? 0,
		incorrectCount: priorRow?.incorrectCount ?? 0,
		streak: priorRow?.streak ?? 0,
		lastAnsweredAt: priorRow?.lastAnsweredAt ?? null,
		lastCorrectAt: priorRow?.lastCorrectAt ?? null,
		activityDay,
		activityWasCorrect: wasCorrect,
	};
}

export async function recordAnswer(
	userId: string,
	options: RecordAnswerOptions,
): Promise<AnswerSnapshot> {
	const { questionKey, wasCorrect } = options;
	// クライアント申告の形式・地域は信用せず、キーから導出・検証する
	const info = getQuestionKeyInfo(questionKey);
	if (!info) {
		// クライアント申告のキー形式が不正 = 入力エラー(400)。
		throw new BadRequestError(`invalid question key: ${questionKey}`);
	}
	// 更新直前の行を控えておき、リセット時にこの値へ復元できるようにする
	const priorRow = await fetchQuestionStatRow(userId, questionKey);
	const now = new Date();
	const activityDay = jstDayKey(now);
	const snapshot: AnswerSnapshot = priorRow
		? {
				existed: true,
				correctCount: priorRow.correctCount,
				incorrectCount: priorRow.incorrectCount,
				streak: priorRow.streak,
				lastAnsweredAt: priorRow.lastAnsweredAt.getTime(),
				lastCorrectAt: priorRow.lastCorrectAt?.getTime() ?? null,
				activityDay,
				activityWasCorrect: wasCorrect,
			}
		: {
				existed: false,
				correctCount: 0,
				incorrectCount: 0,
				streak: 0,
				lastAnsweredAt: null,
				lastCorrectAt: null,
				activityDay,
				activityWasCorrect: wasCorrect,
			};

	// 問題別 stat と日次サマリーと取り消し用スナップショットの3更新を単一の
	// db.batch(=1トランザクション)で原子化する。
	// 逐次 await だと1つ目成功・2つ目失敗の部分失敗で、問題別実績とヒートマップ/streak が
	// 恒久的にずれる(修復手段なし)。D1 batch は暗黙トランザクションなので追加機構は不要(#154)。
	// 取り消し用スナップショットはサーバ側(quiz_pending_revert)に置き、クライアントには
	// 往復させない。PK=userId 単独の上書きで「直前の1回答だけ」を表す(#544)。
	await db.batch([
		db
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
			}),
		// 日次サマリーを加算(今日の学習量・連続学習日数・履歴ヒートマップの元データ)
		db
			.insert(dailyActivity)
			.values({
				userId,
				day: activityDay,
				answeredCount: 1,
				correctCount: wasCorrect ? 1 : 0,
			})
			.onConflictDoUpdate({
				target: [dailyActivity.userId, dailyActivity.day],
				set: {
					answeredCount: sql`${dailyActivity.answeredCount} + 1`,
					correctCount: sql`${dailyActivity.correctCount} + ${wasCorrect ? 1 : 0}`,
					updatedAt: now,
				},
			}),
		// 取り消し用に回答前の値をサーバ側へ保存(クライアント申告にしない #544)
		db
			.insert(quizPendingRevert)
			.values({
				userId,
				...pendingRevertFields(priorRow, questionKey, activityDay, wasCorrect),
				answeredAt: now,
			})
			.onConflictDoUpdate({
				target: quizPendingRevert.userId,
				set: {
					...pendingRevertFields(
						priorRow,
						questionKey,
						activityDay,
						wasCorrect,
					),
					answeredAt: now,
					updatedAt: now,
				},
			}),
	]);
	return snapshot;
}

export interface RevertAnswerOptions {
	questionKey: string;
}

/**
 * 直前の recordAnswer を取り消し、行を回答前の状態へ戻す(誤タップ救済)。
 * 復元に使うスナップショットはサーバ側の quiz_pending_revert から取り、
 * クライアント申告値は受け取らない(#544)。回答で新規作成された行は削除し、
 * 既存行は保存していた値へ復元する。復元対象は認証済みユーザ本人の行のみ。
 *
 * 取り消せるのは全体で最後の1回答だけ。保留行が無い・キーが違う・対象行の
 * lastAnsweredAt が解答時の値と合わない(二重取り消し・上書き後の取り消し)・
 * 現在値が「保留+1回答」と合わない場合は 400 で弾く。日次サマリーの減算日も
 * 保留行の activityDay(サーバが記録した日)を使い、任意日の指定はできない。
 */
export async function revertAnswer(
	userId: string,
	options: RevertAnswerOptions,
): Promise<void> {
	const { questionKey } = options;
	// キーの妥当性を検証(recordAnswer と同じ防御)
	const info = getQuestionKeyInfo(questionKey);
	if (!info) {
		// クライアント申告のキー形式が不正 = 入力エラー(400)。
		throw new BadRequestError(`invalid question key: ${questionKey}`);
	}
	// 保留中の取り消し(直前の1回答)。無ければ取り消す対象が無い
	const pendingRows = await db
		.select()
		.from(quizPendingRevert)
		.where(eq(quizPendingRevert.userId, userId))
		.limit(1);
	const pending = pendingRows[0];
	if (!pending) {
		throw new BadRequestError("no revertable answer");
	}
	// 直前以外のキーへの取り消しは不可(未回答行のDELETE・別問題の書き換えを防ぐ)
	if (pending.questionKey !== questionKey) {
		throw new BadRequestError("only the last answer can be reverted");
	}
	// 対象回答の存在確認
	const current = await fetchQuestionStatRow(userId, questionKey);
	if (!current) {
		throw new BadRequestError("answer not found");
	}
	// 解答時から対象行が上書きされていないこと(二重取り消し・再回答後の取り消しを防ぐ)
	if (current.lastAnsweredAt.getTime() !== pending.answeredAt.getTime()) {
		throw new BadRequestError("answer already reverted or overwritten");
	}
	// prior一致確認: 現在値が「保留スナップショット+1回答」と合うこと。
	// 合わなければ保留と実態が食い違っており、安全に巻き戻せない
	if (!pending.existed) {
		const expectedCorrect = pending.activityWasCorrect ? 1 : 0;
		const expectedIncorrect = pending.activityWasCorrect ? 0 : 1;
		const expectedStreak = pending.activityWasCorrect ? 1 : 0;
		if (
			current.correctCount !== expectedCorrect ||
			current.incorrectCount !== expectedIncorrect ||
			current.streak !== expectedStreak
		) {
			throw new BadRequestError("answer state mismatch");
		}
	} else {
		// existed=true なのに回答前時刻が欠けている保留は壊れているので巻き戻さない
		if (!pending.lastAnsweredAt) {
			throw new BadRequestError("answer state mismatch");
		}
		const expectedCorrect =
			pending.correctCount + (pending.activityWasCorrect ? 1 : 0);
		const expectedIncorrect =
			pending.incorrectCount + (pending.activityWasCorrect ? 0 : 1);
		const expectedStreak = pending.activityWasCorrect ? pending.streak + 1 : 0;
		if (
			current.correctCount !== expectedCorrect ||
			current.incorrectCount !== expectedIncorrect ||
			current.streak !== expectedStreak
		) {
			throw new BadRequestError("answer state mismatch");
		}
	}
	// stat の復元/削除と日次サマリーの減算と保留行の消費を単一の
	// db.batch(=1トランザクション)で原子化する。
	// 逐次 await だと部分失敗でヒートマップ/streak と問題別実績が恒久的にずれる(#154)。
	const restoreStat = !pending.existed
		? // 回答で初めて作られた行なので、丸ごと削除すれば回答前(未出題)に戻る
			db
				.delete(quizQuestionStat)
				.where(
					and(
						eq(quizQuestionStat.userId, userId),
						eq(quizQuestionStat.questionKey, questionKey),
					),
				)
		: db
				.update(quizQuestionStat)
				.set({
					correctCount: pending.correctCount,
					incorrectCount: pending.incorrectCount,
					streak: pending.streak,
					// existed=true の行は lastAnsweredAt が非null。欠けていたら壊れた保留なので弾く
					lastAnsweredAt: pending.lastAnsweredAt ?? current.lastAnsweredAt,
					lastCorrectAt: pending.lastCorrectAt ?? null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(quizQuestionStat.userId, userId),
						eq(quizQuestionStat.questionKey, questionKey),
					),
				);

	await db.batch([
		restoreStat,
		// 日次サマリーも対称的に減算。減算日・正誤はサーバが記録した保留行から取り、
		// クライアントは指定できない(任意日減算を防ぐ)。
		// 負値ガードで下限0に丸める。行が無ければ何もしない(max(0,...) が保証)。
		db
			.update(dailyActivity)
			.set({
				answeredCount: sql`max(0, ${dailyActivity.answeredCount} - 1)`,
				correctCount: sql`max(0, ${dailyActivity.correctCount} - ${pending.activityWasCorrect ? 1 : 0})`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(dailyActivity.userId, userId),
					eq(dailyActivity.day, pending.activityDay),
				),
			),
		// 保留を消費する(二重取り消しを防ぐ)
		db.delete(quizPendingRevert).where(eq(quizPendingRevert.userId, userId)),
	]);
}

interface QuizTypeProgress {
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
			const counts = candidateCountsByType(region.id);
			const quizTypes = (Object.entries(counts) as [QuizType, number][]).map(
				([quizType, candidateCount]) => {
					const row = byRegionAndType.get(`${region.id}:${quizType}`);
					// AOPデータ更新でキーが失効しても stat 行は残るため seen>candidate になりうる。
					// getAopSolvedProgress と同様に候補数でクランプし、進捗画面の「未出題」負値・
					// 進捗バー100%超を防ぐ(#152)。問題別カウント(seen/weak/mastered)のみ対象で、
					// 延べ回答数(answer/correct)は1問に複数回答があるためクランプしない。
					return {
						quizType,
						candidateCount,
						seenCount: Math.min(row?.seenCount ?? 0, candidateCount),
						answerCount: row?.answerCount ?? 0,
						correctCount: row?.correctCount ?? 0,
						weakCount: Math.min(row?.weakCount ?? 0, candidateCount),
						masteredCount: Math.min(row?.masteredCount ?? 0, candidateCount),
					};
				},
			);
			return { regionId: region.id, quizTypes };
		});
	return { regions };
}

/** AOP(slug)単位の学習進捗。solved=正解済み問題数 / total=候補問題総数 */
export interface AopProgress {
	solved: number;
	total: number;
}

/**
 * 地図・リストの進捗表示用: 指定地域について、AOP(slug)ごとの
 * 「正解済み問題数(solved)」と「候補問題総数(total)」を返す。
 * 「正解済み」= 一度でも正解した問題(correctCount > 0)。問題キーの末尾セグメントが
 * 対象AOPのslugなので、キーをJS側で集計する(AOP単位の集計列はDBに持たない)。
 * 母数・正解数とも関連クイズ(listScopedCandidates)と同じ形式定義に揃える:
 * 主語形式 + グラン・クリュ形式を数え、たまたま正解が近傍AOPになるだけの
 * 回答側形式(odd-one-out/variety/location)は進捗対象から除外する(#485)。
 * 候補問題を持つ全AOP(total>0)を返す(村・地区の合算や未着手AOPの分母表示に使う)。
 * 未ログイン(userId=null)時はDBを引かず solved=0 として total のみ返す。
 */
export async function getAopSolvedProgress(
	userId: string | null,
	regionId: RegionId,
): Promise<{ byAopId: Record<string, AopProgress> }> {
	// 1行=1キー=1問。正解済み(correctCount>0)の問題だけをAOPごとに数える
	const solvedByAopId = new Map<string, number>();
	if (userId) {
		const rows = await db
			.select({
				questionKey: quizQuestionStat.questionKey,
				correctCount: quizQuestionStat.correctCount,
			})
			.from(quizQuestionStat)
			.where(
				and(
					eq(quizQuestionStat.userId, userId),
					eq(quizQuestionStat.regionId, regionId),
				),
			);
		for (const row of rows) {
			if (row.correctCount <= 0) continue;
			const parsed = parseKey(row.questionKey);
			if (!parsed) continue;
			// 回答側形式は進捗の分母(candidateCountsByAopId)から除外しているので、
			// 正解数側でも同形式を除外して分子・分母の定義を揃える
			// (グラン・クリュ形式は分母に含めるためここでも数える #485)
			if (OUT_OF_SCOPE_QUIZ_TYPES.has(parsed.quizType)) continue;
			solvedByAopId.set(
				parsed.aopId,
				(solvedByAopId.get(parsed.aopId) ?? 0) + 1,
			);
		}
	}

	const candidateCounts = candidateCountsByAopId(regionId);
	const byAopId: Record<string, AopProgress> = {};
	for (const [aopId, total] of candidateCounts) {
		if (total <= 0) continue;
		const solved = Math.min(solvedByAopId.get(aopId) ?? 0, total);
		byAopId[aopId] = { solved, total };
	}
	return { byAopId };
}
