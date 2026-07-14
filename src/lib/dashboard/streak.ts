import { addDays } from "./jst";

// 連続学習日数(streak)の算出。純関数。DBアクセスはサービス層が担う。

/**
 * 学習した日の集合(dayKey "YYYY-MM-DD")と今日から、連続学習日数を返す。
 * - 今日学習済みなら今日から遡って連続日数を数える。
 * - 今日まだ未学習でも、昨日まで連続していれば streak は維持されている(今日中に
 *   解けば途切れない)とみなし、昨日から遡って数える。
 * - 今日も昨日も未学習なら 0。
 */
export function computeStreak(
	activeDays: ReadonlySet<string>,
	todayKey: string,
): number {
	// 起点: 今日が埋まっていれば今日、そうでなければ昨日。どちらも無ければ0。
	let cursor: string;
	if (activeDays.has(todayKey)) {
		cursor = todayKey;
	} else {
		const yesterday = addDays(todayKey, -1);
		if (!activeDays.has(yesterday)) return 0;
		cursor = yesterday;
	}

	let streak = 0;
	while (activeDays.has(cursor)) {
		streak++;
		cursor = addDays(cursor, -1);
	}
	return streak;
}
