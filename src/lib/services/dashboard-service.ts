import { and, eq, gte } from "drizzle-orm";
import { db } from "#/db";
import { dailyActivity } from "#/db/schema";
import { DAILY_GOAL, HEATMAP_DAYS } from "#/lib/dashboard/constants";
import { jstDayKey, lastNDayKeys } from "#/lib/dashboard/jst";
import {
	pickRecommendation,
	type Recommendation,
	type RegionStat,
} from "#/lib/dashboard/recommend";
import { computeStreak } from "#/lib/dashboard/streak";
import type { RegionId } from "#/lib/wine/types";
import {
	countAndLatestDrunkWine,
	type DrunkWineEntry,
} from "./drunk-wine-service";
import { getProgress } from "./quiz-service";

// ログイン後トップページの学習ダッシュボード用サービス層。既存の集計
// (getProgress / daily_activity / drunk_wine)を束ね、UIが必要とする形に整える。
// 日付・streak・おすすめ選定などのロジックは #/lib/dashboard の純関数に委ねる。

export interface DashboardData {
	/** 今日の学習量。goal は達成度バーの分母 */
	today: { answered: number; correct: number; goal: number };
	/** 連続学習日数 */
	streak: number;
	/** 直近 HEATMAP_DAYS 日の学習量(古い順)。空枠も 0 で埋める */
	heatmap: { day: string; answered: number }[];
	/** 全地域横断の習熟度(問題数ベース) */
	mastery: { total: number; seen: number; mastered: number; weak: number };
	/** 「今日はどこから」= おすすめ1件 */
	recommendation: Recommendation;
	/** マイセラー */
	cellar: { count: number; latest: DrunkWineEntry | null };
}

export async function getDashboard(userId: string): Promise<DashboardData> {
	const todayKey = jstDayKey(new Date());

	// 日次テーブルはヒートマップの範囲だけ引けば today も streak も賄える
	// (streak は範囲内の連続で十分。範囲外まで遡る超長期 streak は表示要件外)。
	const rangeStart = lastNDayKeys(todayKey, HEATMAP_DAYS)[0];
	const activityRows = await db
		.select({
			day: dailyActivity.day,
			answeredCount: dailyActivity.answeredCount,
		})
		.from(dailyActivity)
		.where(
			and(eq(dailyActivity.userId, userId), gte(dailyActivity.day, rangeStart)),
		);

	const answeredByDay = new Map(
		activityRows.map((r) => [r.day, r.answeredCount]),
	);
	const activeDays = new Set(
		activityRows.filter((r) => r.answeredCount > 0).map((r) => r.day),
	);

	const [todayRow] = await db
		.select({
			answeredCount: dailyActivity.answeredCount,
			correctCount: dailyActivity.correctCount,
		})
		.from(dailyActivity)
		.where(
			and(eq(dailyActivity.userId, userId), eq(dailyActivity.day, todayKey)),
		);

	const heatmap = lastNDayKeys(todayKey, HEATMAP_DAYS).map((day) => ({
		day,
		answered: answeredByDay.get(day) ?? 0,
	}));

	// クイズ習熟度: 既存の getProgress(地域×形式)を横断集計する
	const { regions } = await getProgress(userId);
	const mastery = { total: 0, seen: 0, mastered: 0, weak: 0 };
	const regionStats: RegionStat[] = regions.map((region) => {
		const agg = region.quizTypes.reduce(
			(acc, t) => ({
				candidate: acc.candidate + t.candidateCount,
				seen: acc.seen + t.seenCount,
				mastered: acc.mastered + t.masteredCount,
				weak: acc.weak + t.weakCount,
			}),
			{ candidate: 0, seen: 0, mastered: 0, weak: 0 },
		);
		mastery.total += agg.candidate;
		mastery.seen += agg.seen;
		mastery.mastered += agg.mastered;
		mastery.weak += agg.weak;
		return {
			regionId: region.regionId as RegionId,
			candidateCount: agg.candidate,
			seenCount: agg.seen,
			weakCount: agg.weak,
			masteredCount: agg.mastered,
		};
	});

	const cellar = await countAndLatestDrunkWine(userId);

	return {
		today: {
			answered: todayRow?.answeredCount ?? 0,
			correct: todayRow?.correctCount ?? 0,
			goal: DAILY_GOAL,
		},
		streak: computeStreak(activeDays, todayKey),
		heatmap,
		mastery,
		recommendation: pickRecommendation(regionStats),
		cellar,
	};
}
