// JST(Asia/Tokyo)の暦日を扱う純関数。学習アプリのユーザは実質国内で、JSTには
// DSTが無いため UTC+9 の固定オフセットで確定できる(Intl不要)。日次テーブル
// daily_activity の day キー("YYYY-MM-DD")の生成・列挙に使う。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 与えた時刻を JST の暦日 "YYYY-MM-DD" に変換する */
export function jstDayKey(date: Date): string {
	// UTC時刻に+9hしてからUTCとして日付部分を取ると、JSTの暦日になる
	return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" を JST 正午の Date に戻す(日付演算の基点。DST無なので正午で十分安全) */
function dayKeyToDate(dayKey: string): Date {
	// 正午JST = 03:00 UTC。前後1日ずれる心配のない基点にする
	return new Date(`${dayKey}T03:00:00.000Z`);
}

/** dayKey の n 日前(n>0)/後(n<0)の dayKey を返す */
export function addDays(dayKey: string, n: number): string {
	return jstDayKey(new Date(dayKeyToDate(dayKey).getTime() + n * DAY_MS));
}

/**
 * todayKey を末尾(最新)にして直近 n 日分の dayKey を古い順に返す。
 * ヒートマップの空枠生成に使う。
 */
export function lastNDayKeys(todayKey: string, n: number): string[] {
	const keys: string[] = [];
	for (let i = n - 1; i >= 0; i--) {
		keys.push(addDays(todayKey, -i));
	}
	return keys;
}
