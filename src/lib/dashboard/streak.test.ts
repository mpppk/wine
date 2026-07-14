import { describe, expect, it } from "vitest";
import { computeStreak } from "./streak";

const TODAY = "2026-07-14";

describe("computeStreak", () => {
	it("空データは0", () => {
		expect(computeStreak(new Set(), TODAY)).toBe(0);
	});

	it("今日から連続している分を数える", () => {
		const days = new Set(["2026-07-12", "2026-07-13", "2026-07-14"]);
		expect(computeStreak(days, TODAY)).toBe(3);
	});

	it("今日未学習でも昨日まで連続なら維持(昨日から数える)", () => {
		const days = new Set(["2026-07-12", "2026-07-13"]);
		expect(computeStreak(days, TODAY)).toBe(2);
	});

	it("今日も昨日も未学習なら0(途切れている)", () => {
		const days = new Set(["2026-07-11", "2026-07-12"]);
		expect(computeStreak(days, TODAY)).toBe(0);
	});

	it("途中に欠けがあれば直近の連続分だけ数える", () => {
		const days = new Set([
			"2026-07-10",
			// 07-11 欠け
			"2026-07-13",
			"2026-07-14",
		]);
		expect(computeStreak(days, TODAY)).toBe(2);
	});

	it("今日のみ学習は1", () => {
		expect(computeStreak(new Set([TODAY]), TODAY)).toBe(1);
	});

	it("月をまたいでも連続を数える", () => {
		const days = new Set(["2026-07-31", "2026-08-01"]);
		expect(computeStreak(days, "2026-08-01")).toBe(2);
	});
});
