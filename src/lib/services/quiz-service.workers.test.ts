import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { dailyActivity, quizQuestionStat } from "#/db/schema";
import { candidateCountsByType, listCandidates } from "#/lib/quiz/generators";
import type { QuizType } from "#/lib/quiz/types";
import { listRegions } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { getProgress, recordAnswer } from "./quiz-service";

// D1(実SQLite)上で quiz-service を検証する。型チェックでは守れない生SQL断片
// (onConflictDoUpdate の加算・streak リセット・case-when 集計)の符号や条件の
// 取り違えを、実際にクエリを走らせて捕捉する(Issue #50)。

// 有効な地域と、候補問題を持つ形式・実在する問題キーを実データから引く。
// recordAnswer は getQuestionKeyInfo でキーの実在を検証するため、合成キーではなく
// listCandidates が返す本物のキーを使う必要がある。
const region = listRegions().find((r) => r.enabled);
if (!region)
	throw new Error("有効な地域が1つも無い(テストデータ前提が崩れている)");
const regionId: RegionId = region.id;
const counts = candidateCountsByType(regionId);
const quizType = (Object.keys(counts) as QuizType[]).find((t) => counts[t] > 0);
if (!quizType) throw new Error(`候補問題を持つ形式が無い: ${regionId}`);
const realKeys = listCandidates(regionId, [quizType]);

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `qs-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "quiz tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

async function statRow(userId: string, questionKey: string) {
	const rows = await db
		.select()
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

describe("recordAnswer", () => {
	let userId: string;
	let key: string;
	beforeEach(async () => {
		userId = await freshUser();
		key = realKeys[0] as string;
	});

	it("初回正解で行を新規作成する(correct=1 / streak=1 / lastCorrectAt が入る)", async () => {
		const snapshot = await recordAnswer(userId, {
			questionKey: key,
			wasCorrect: true,
		});
		// 更新前スナップショットは「存在しなかった」状態
		expect(snapshot.existed).toBe(false);
		const row = await statRow(userId, key);
		expect(row?.correctCount).toBe(1);
		expect(row?.incorrectCount).toBe(0);
		expect(row?.streak).toBe(1);
		expect(row?.lastCorrectAt).not.toBeNull();
	});

	it("初回不正解で行を新規作成する(incorrect=1 / streak=0 / lastCorrectAt は null)", async () => {
		await recordAnswer(userId, { questionKey: key, wasCorrect: false });
		const row = await statRow(userId, key);
		expect(row?.correctCount).toBe(0);
		expect(row?.incorrectCount).toBe(1);
		expect(row?.streak).toBe(0);
		expect(row?.lastCorrectAt).toBeNull();
	});

	it("正解→正解で加算し streak を伸ばす", async () => {
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		const row = await statRow(userId, key);
		expect(row?.correctCount).toBe(2);
		expect(row?.incorrectCount).toBe(0);
		expect(row?.streak).toBe(2);
	});

	it("不正解は streak を 0 にハードリセットし、lastCorrectAt は直前の正解時刻を保持する", async () => {
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		const beforeWrong = await statRow(userId, key);
		const keptLastCorrect = beforeWrong?.lastCorrectAt?.getTime();
		expect(keptLastCorrect).toBeGreaterThan(0);

		await recordAnswer(userId, { questionKey: key, wasCorrect: false });
		const row = await statRow(userId, key);
		expect(row?.correctCount).toBe(2);
		expect(row?.incorrectCount).toBe(1);
		// streak は +（-1でなく）0 にリセット
		expect(row?.streak).toBe(0);
		// 不正解では set に lastCorrectAt を含めないため、直前の正解時刻が保たれる
		expect(row?.lastCorrectAt?.getTime()).toBe(keptLastCorrect);
	});

	it("既存行があるスナップショットは existed=true と更新前の値を返す", async () => {
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		const snapshot = await recordAnswer(userId, {
			questionKey: key,
			wasCorrect: false,
		});
		expect(snapshot.existed).toBe(true);
		// 2回目呼び出しが受け取るのは1回目適用後の値
		expect(snapshot.correctCount).toBe(1);
		expect(snapshot.streak).toBe(1);
	});

	it("daily_activity を解答ごとに加算する(answered=延べ / correct=正解のみ)", async () => {
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		await recordAnswer(userId, { questionKey: key, wasCorrect: true });
		await recordAnswer(userId, { questionKey: key, wasCorrect: false });
		const rows = await db
			.select()
			.from(dailyActivity)
			.where(eq(dailyActivity.userId, userId));
		// 同一日なら1行。JST日跨ぎに備え合算で検証する
		const answered = rows.reduce((a, r) => a + r.answeredCount, 0);
		const correct = rows.reduce((a, r) => a + r.correctCount, 0);
		expect(answered).toBe(3);
		expect(correct).toBe(2);
	});
});

describe("getProgress", () => {
	it("streak を weak(=0)/mastered(>=2)に集計し、region×quizType でまとめる", async () => {
		const userId = await freshUser();
		const now = new Date();
		// streak 0/1/2/3 を1件ずつ直接投入(集計対象の列だけ効くので合成キーで良い)
		const streaks = [0, 1, 2, 3];
		await db.insert(quizQuestionStat).values(
			streaks.map((streak, i) => ({
				userId,
				questionKey: `${quizType}:progress-fixture-${i}`,
				quizType,
				regionId,
				correctCount: streak, // correct 数は集計値の確認用に streak と揃える
				incorrectCount: 1,
				streak,
				lastAnsweredAt: now,
				lastCorrectAt: streak > 0 ? now : null,
			})),
		);

		const { regions } = await getProgress(userId);
		const target = regions
			.find((r) => r.regionId === regionId)
			?.quizTypes.find((q) => q.quizType === quizType);
		expect(target).toBeDefined();
		expect(target?.seenCount).toBe(4);
		// weak = streak が 0 の1件
		expect(target?.weakCount).toBe(1);
		// mastered = streak>=2 の2件(streak 2,3)
		expect(target?.masteredCount).toBe(2);
		// answerCount = Σ(correct+incorrect) = (0+1)+(1+1)+(2+1)+(3+1) = 10
		expect(target?.answerCount).toBe(10);
		// correctCount = Σcorrect = 0+1+2+3 = 6
		expect(target?.correctCount).toBe(6);
	});

	it("失効キーで seen が候補数を超えても candidateCount にクランプする(#152)", async () => {
		const userId = await freshUser();
		const now = new Date();
		const candidate = counts[quizType];
		// 候補数を超える数の stat 行を投入(AOPデータ更新でキーが失効した状況を模す)。
		// 全て streak 0 = weak にして、seen/weak がクランプされることを確認する。
		const extra = candidate + 3;
		const staleRows = Array.from({ length: extra }, (_, i) => ({
			userId,
			questionKey: `${quizType}:stale-${i}`,
			quizType,
			regionId,
			correctCount: 1,
			incorrectCount: 0,
			streak: 0,
			lastAnsweredAt: now,
			lastCorrectAt: now,
		}));
		// D1 の SQL 変数上限(100)に収まるよう分割投入する(1行9変数)
		for (let i = 0; i < staleRows.length; i += 10) {
			await db.insert(quizQuestionStat).values(staleRows.slice(i, i + 10));
		}

		const { regions } = await getProgress(userId);
		const target = regions
			.find((r) => r.regionId === regionId)
			?.quizTypes.find((q) => q.quizType === quizType);
		expect(target?.candidateCount).toBe(candidate);
		// seen/weak は候補数でクランプされ、負の「未出題」や100%超を生まない
		expect(target?.seenCount).toBe(candidate);
		expect(target?.weakCount).toBe(candidate);
		expect(target?.masteredCount).toBe(0);
	});

	it("実績が無いユーザは全形式 0 で返る(候補数は静的データから)", async () => {
		const userId = await freshUser();
		const { regions } = await getProgress(userId);
		const target = regions
			.find((r) => r.regionId === regionId)
			?.quizTypes.find((q) => q.quizType === quizType);
		expect(target?.seenCount).toBe(0);
		expect(target?.weakCount).toBe(0);
		expect(target?.masteredCount).toBe(0);
		// 候補数(分母)は実績と無関係に静的データ由来で正の値
		expect(target?.candidateCount).toBeGreaterThan(0);
	});
});
