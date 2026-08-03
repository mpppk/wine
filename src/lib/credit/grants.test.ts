import { describe, expect, it } from "vitest";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import {
	grantRequestId,
	grantUpgradeRequestId,
	monthlyGrantForPlan,
} from "./grants";

describe("monthlyGrantForPlan", () => {
	it("プレミアムは無料より多い付与", () => {
		expect(MONTHLY_CREDITS_PREMIUM).toBeGreaterThan(MONTHLY_CREDITS_FREE);
	});

	it("プランに応じた付与額を返す", () => {
		expect(monthlyGrantForPlan(true)).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(monthlyGrantForPlan(false)).toBe(MONTHLY_CREDITS_FREE);
	});
});

describe("付与台帳の requestId 導出", () => {
	it("リセット付与は (userId, month) で月1本に絞られる", () => {
		expect(grantRequestId("u1", "2026-08")).toBe("grant:u1:2026-08");
		expect(grantRequestId("u1", "2026-08")).toBe(
			grantRequestId("u1", "2026-08"),
		);
		expect(grantRequestId("u1", "2026-09")).not.toBe(
			grantRequestId("u1", "2026-08"),
		);
	});

	it("差分付与は付与目標額まで含めてキーになる(#387)", () => {
		expect(grantUpgradeRequestId("u1", "2026-08", 1500)).toBe(
			"grant_upgrade:u1:2026-08:1500",
		);
		// 同じ目標額への引き上げは同じキー(=月1本)。
		expect(grantUpgradeRequestId("u1", "2026-08", 1500)).toBe(
			grantUpgradeRequestId("u1", "2026-08", 1500),
		);
		// 目標額が違えば別キー。付与額の増額(150)と昇格(1500)が同月に重なっても互いを潰さない。
		expect(grantUpgradeRequestId("u1", "2026-08", 150)).not.toBe(
			grantUpgradeRequestId("u1", "2026-08", 1500),
		);
	});

	it("リセット付与と差分付与のキーは衝突しない", () => {
		expect(grantRequestId("u1", "2026-08")).not.toBe(
			grantUpgradeRequestId("u1", "2026-08", MONTHLY_CREDITS_PREMIUM),
		);
	});
});
