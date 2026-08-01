import { describe, expect, it } from "vitest";
import { calendarDateSchema, isCalendarDate } from "./calendar-date";

// 形式が合っていても実在しない日付を通さないこと。drank_on / seen_on の
// 両方がこの1実装に依存するので、境界はここで固定する。

describe("isCalendarDate", () => {
	it("実在する日付を通す", () => {
		expect(isCalendarDate("2026-07-31")).toBe(true);
		expect(isCalendarDate("2024-02-29")).toBe(true); // 閏年
	});

	it("形式は合っているが実在しない日付を弾く", () => {
		expect(isCalendarDate("2026-02-31")).toBe(false);
		expect(isCalendarDate("2025-02-29")).toBe(false); // 平年
		expect(isCalendarDate("2026-13-01")).toBe(false);
		expect(isCalendarDate("2026-00-10")).toBe(false);
	});

	it("年を1900-2100に制限する(Date.UTC の 0-99 年マッピングの罠を含む)", () => {
		expect(isCalendarDate("1900-01-01")).toBe(true);
		expect(isCalendarDate("2100-12-31")).toBe(true);
		expect(isCalendarDate("1899-12-31")).toBe(false);
		expect(isCalendarDate("2101-01-01")).toBe(false);
		// "0050-01-01" は Date.UTC(50,...) が 1950 年になるが、範囲チェックが先に弾く
		expect(isCalendarDate("0050-01-01")).toBe(false);
	});
});

describe("calendarDateSchema", () => {
	it("形式外の文字列を弾く", () => {
		expect(calendarDateSchema.safeParse("2026-7-31").success).toBe(false);
		expect(calendarDateSchema.safeParse("2026/07/31").success).toBe(false);
		expect(calendarDateSchema.safeParse("").success).toBe(false);
	});

	it("実在しない暦日を弾く", () => {
		expect(calendarDateSchema.safeParse("2026-02-31").success).toBe(false);
	});

	it("実在する暦日を通す", () => {
		expect(calendarDateSchema.safeParse("2026-07-31").success).toBe(true);
	});
});
