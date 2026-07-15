import { describe, expect, it } from "vitest";
import { currentMonthKey } from "./month";

describe("currentMonthKey", () => {
	it("JST の暦月 YYYY-MM を返す", () => {
		expect(currentMonthKey(new Date("2026-07-15T03:00:00Z"))).toBe("2026-07");
	});

	it("UTC月末深夜でも JST では翌月に繰り上がる", () => {
		// 2026-06-30T20:00Z = JST 2026-07-01 05:00 → "2026-07"
		expect(currentMonthKey(new Date("2026-06-30T20:00:00Z"))).toBe("2026-07");
	});

	it("UTCで年をまたぐ境界も JST で判定する", () => {
		// 2026-12-31T20:00Z = JST 2027-01-01 05:00 → "2027-01"
		expect(currentMonthKey(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01");
	});
});
