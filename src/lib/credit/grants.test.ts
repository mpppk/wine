import { describe, expect, it } from "vitest";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import { monthlyGrantForPlan } from "./grants";

describe("monthlyGrantForPlan", () => {
	it("プレミアムは無料より多い付与", () => {
		expect(MONTHLY_CREDITS_PREMIUM).toBeGreaterThan(MONTHLY_CREDITS_FREE);
	});

	it("プランに応じた付与額を返す", () => {
		expect(monthlyGrantForPlan(true)).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(monthlyGrantForPlan(false)).toBe(MONTHLY_CREDITS_FREE);
	});
});
