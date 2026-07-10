import { describe, expect, it } from "vitest";
import {
	isSubscriptionEntitled,
	resolvePlan,
	shouldShowAds,
} from "./entitlements";

const NOW = new Date("2026-07-10T00:00:00Z");
const FUTURE = new Date("2026-08-10T00:00:00Z");
const HOURS = 60 * 60 * 1000;

describe("isSubscriptionEntitled", () => {
	it("active / trialing は有効", () => {
		expect(
			isSubscriptionEntitled({ status: "active", periodEnd: FUTURE }, NOW),
		).toBe(true);
		expect(
			isSubscriptionEntitled({ status: "trialing", periodEnd: FUTURE }, NOW),
		).toBe(true);
	});

	it("それ以外の status は無効", () => {
		for (const status of [
			"canceled",
			"incomplete",
			"incomplete_expired",
			"past_due",
			"paused",
			"unpaid",
			null,
		]) {
			expect(isSubscriptionEntitled({ status, periodEnd: FUTURE }, NOW)).toBe(
				false,
			);
		}
	});

	it("periodEnd 未設定なら status のみで判定する", () => {
		expect(isSubscriptionEntitled({ status: "active" }, NOW)).toBe(true);
		expect(
			isSubscriptionEntitled({ status: "active", periodEnd: null }, NOW),
		).toBe(true);
	});

	it("periodEnd + 猶予24hを超えたら status=active でも無効(webhook欠落のフェイルセーフ)", () => {
		const periodEnd = new Date(NOW.getTime() - 25 * HOURS);
		expect(isSubscriptionEntitled({ status: "active", periodEnd }, NOW)).toBe(
			false,
		);
	});

	it("periodEnd 経過後でも猶予24h以内は有効(webhook反映ラグを許容)", () => {
		const periodEnd = new Date(NOW.getTime() - 23 * HOURS);
		expect(isSubscriptionEntitled({ status: "active", periodEnd }, NOW)).toBe(
			true,
		);
	});
});

describe("resolvePlan", () => {
	it("サブスクリプション0件は free", () => {
		expect(resolvePlan([], NOW)).toBe("free");
	});

	it("有効なサブスクリプションが1件でもあれば premium", () => {
		expect(
			resolvePlan(
				[
					{ status: "canceled", periodEnd: FUTURE },
					{ status: "active", periodEnd: FUTURE },
				],
				NOW,
			),
		).toBe("premium");
	});

	it("無効なサブスクリプションのみなら free", () => {
		expect(
			resolvePlan(
				[
					{ status: "canceled", periodEnd: FUTURE },
					{ status: "incomplete", periodEnd: FUTURE },
				],
				NOW,
			),
		).toBe("free");
	});
});

describe("shouldShowAds", () => {
	it("embed 配下では常に非表示(MCP Apps の iframe)", () => {
		expect(
			shouldShowAds({
				pathname: "/embed/map",
				billing: { kind: "success", isPremium: false },
			}),
		).toBe(false);
		expect(
			shouldShowAds({ pathname: "/embed", billing: { kind: "error" } }),
		).toBe(false);
	});

	it("embed に前方一致するだけの別パスは対象外", () => {
		expect(
			shouldShowAds({
				pathname: "/embedded",
				billing: { kind: "success", isPremium: false },
			}),
		).toBe(true);
	});

	it("取得中は非表示(プレミアム会員への広告フラッシュ防止)", () => {
		expect(
			shouldShowAds({ pathname: "/quiz/play", billing: { kind: "loading" } }),
		).toBe(false);
	});

	it("取得失敗時は無料会員扱いで表示", () => {
		expect(
			shouldShowAds({ pathname: "/quiz/play", billing: { kind: "error" } }),
		).toBe(true);
	});

	it("無料会員(未ログイン含む)は表示、プレミアムは非表示", () => {
		expect(
			shouldShowAds({
				pathname: "/quiz/play",
				billing: { kind: "success", isPremium: false },
			}),
		).toBe(true);
		expect(
			shouldShowAds({
				pathname: "/quiz/play",
				billing: { kind: "success", isPremium: true },
			}),
		).toBe(false);
	});
});
