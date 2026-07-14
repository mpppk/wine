import { describe, expect, it } from "vitest";
import { addDays, jstDayKey, lastNDayKeys } from "./jst";

describe("jstDayKey", () => {
	it("UTCの日付をJST(+9h)の暦日に変換する", () => {
		// 2026-07-14T20:00:00Z は JST では 2026-07-15 05:00
		expect(jstDayKey(new Date("2026-07-14T20:00:00Z"))).toBe("2026-07-15");
		// 2026-07-14T10:00:00Z は JST では 2026-07-14 19:00
		expect(jstDayKey(new Date("2026-07-14T10:00:00Z"))).toBe("2026-07-14");
	});

	it("JST深夜(UTC15:00)境界で日付が繰り上がる", () => {
		// 14:59 UTC = 23:59 JST(まだ当日)
		expect(jstDayKey(new Date("2026-07-14T14:59:00Z"))).toBe("2026-07-14");
		// 15:00 UTC = 00:00 JST(翌日)
		expect(jstDayKey(new Date("2026-07-14T15:00:00Z"))).toBe("2026-07-15");
	});
});

describe("addDays", () => {
	it("前後の暦日を返す", () => {
		expect(addDays("2026-07-14", -1)).toBe("2026-07-13");
		expect(addDays("2026-07-14", 1)).toBe("2026-07-15");
	});

	it("月・年をまたぐ", () => {
		expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
	});

	it("うるう年の2月末を跨ぐ", () => {
		expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
	});
});

describe("lastNDayKeys", () => {
	it("todayを末尾に古い順でn日分返す", () => {
		expect(lastNDayKeys("2026-07-14", 3)).toEqual([
			"2026-07-12",
			"2026-07-13",
			"2026-07-14",
		]);
	});

	it("n=1はtoday1件", () => {
		expect(lastNDayKeys("2026-07-14", 1)).toEqual(["2026-07-14"]);
	});
});
