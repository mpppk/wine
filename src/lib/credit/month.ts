import { jstDayKey } from "#/lib/dashboard/jst";

// クレジットの付与・失効は JST の暦月単位。daily_activity.day と同じ時間帯規約に
// 揃えるため、jstDayKey("YYYY-MM-DD") の先頭7文字を月キーとして使う。

/** 与えた時刻(既定=現在)を JST の暦月 "YYYY-MM" に変換する。 */
export function currentMonthKey(date: Date = new Date()): string {
	return jstDayKey(date).slice(0, 7);
}
