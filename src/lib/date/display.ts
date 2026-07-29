// 画面に出す日時の整形。**実行環境のタイムゾーンに依存させない**ための共通入口(#244)。
//
// このアプリの時刻規約は JST(daily_activity.day / クレジットの月境界。docs/architecture.md)。
// 一方 workerd の既定TZは UTC で、ブラウザは端末のTZになる。timeZone を指定せずに
// toLocaleString すると、同じ Date が SSR では UTC・ハイドレーション後は端末TZで整形され、
// 文字列が食い違って hydration mismatch を起こす(JSTのユーザには9時間前の日付が一瞬見える)。
//
// 表示は常に JST 固定にする。日付整形が要る箇所はここを通す。

/** 表示に使うタイムゾーン。アプリの時刻規約(JST)と揃える。 */
export const APP_TIME_ZONE = "Asia/Tokyo";

/** 日時("YYYY/M/D H:MM:SS")。JST固定。 */
export function formatDateTimeJst(date: Date): string {
	return date.toLocaleString("ja-JP", { timeZone: APP_TIME_ZONE });
}

/** 日付のみ("YYYY/M/D")。JST固定。 */
export function formatDateJst(date: Date): string {
	return date.toLocaleDateString("ja-JP", { timeZone: APP_TIME_ZONE });
}
