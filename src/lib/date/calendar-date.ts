import { z } from "zod";

// zone を持たない暦日("YYYY-MM-DD")の検証。単一情報源。
//
// このアプリには zone なしの text-date が複数ある(wine_tasting.drank_on =
// 飲んだ日、wine_sighting.seen_on = 見かけた日、daily_activity.day)。形式だけ
// 見て 2026-02-31 を通すと、集計の MAX や日付順の並びに実在しない日が混ざる。
// ドメインごとに書くと検証がドリフトするため、パターンと暦日判定をここへ寄せる。
//
// ランタイム非依存(cloudflare:workers を import しない)に保つ。Web の server fn・
// MCP ツール・フォームのどこからでも同じ規約で使えるようにするため。

/** "YYYY-MM-DD" の形式。 */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 形式だけでなく暦として実在する日付か(2026-02-31 等を弾く)。
 * Web はブラウザの date input が守るが、MCP 経由は素の文字列が来る。
 *
 * 年は 1900-2100 に制限する。ユーザが手で入れる日付(飲んだ日・見かけた日)の
 * 現実的な範囲であると同時に、Date.UTC の 0-99 年 → 1900 年代マッピングの罠
 * (new Date(Date.UTC(50, 0, 1)) が 1950 年になる)も同時に回避できる。
 */
export function isCalendarDate(s: string): boolean {
	const [y, m, d] = s.split("-").map(Number);
	if (y === undefined || m === undefined || d === undefined) return false;
	if (y < 1900 || y > 2100) return false;
	const dt = new Date(Date.UTC(y, m - 1, d));
	return (
		dt.getUTCFullYear() === y &&
		dt.getUTCMonth() === m - 1 &&
		dt.getUTCDate() === d
	);
}

/**
 * 暦日の zod パーツ。日付を受ける入力スキーマはこれを `.optional()` 等で
 * 包んで使い、regex と refine を各自書き直さない。
 */
export const calendarDateSchema = z
	.string()
	.regex(CALENDAR_DATE_PATTERN)
	.refine(isCalendarDate, "invalid calendar date");
