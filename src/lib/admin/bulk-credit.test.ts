import { describe, expect, it } from "vitest";
import { bulkGrantSubrequestBudget, validateBulkGrant } from "./bulk-credit";
import { ADMIN_CREDIT_GRANT_MAX, ADMIN_CREDIT_GRANT_MIN } from "./credit-grant";

const base = {
	incidentId: "incident-2026-07-20",
	amount: 100,
	fromMs: 1_000,
	toMs: 2_000,
};

describe("validateBulkGrant", () => {
	it("有効な入力は null", () => {
		expect(validateBulkGrant(base)).toBeNull();
		expect(
			validateBulkGrant({ ...base, amount: ADMIN_CREDIT_GRANT_MIN }),
		).toBeNull();
		expect(
			validateBulkGrant({ ...base, amount: ADMIN_CREDIT_GRANT_MAX }),
		).toBeNull();
	});

	it("インシデントID未入力は incident_required", () => {
		expect(validateBulkGrant({ ...base, incidentId: "" })).toBe(
			"incident_required",
		);
		expect(validateBulkGrant({ ...base, incidentId: "   " })).toBe(
			"incident_required",
		);
	});

	it("インシデントIDに不正文字は incident_invalid", () => {
		expect(validateBulkGrant({ ...base, incidentId: "bad id!" })).toBe(
			"incident_invalid",
		);
		expect(validateBulkGrant({ ...base, incidentId: "a:b" })).toBe(
			"incident_invalid",
		);
	});

	it("付与額が範囲外・非整数は amount_invalid", () => {
		expect(validateBulkGrant({ ...base, amount: 0 })).toBe("amount_invalid");
		expect(validateBulkGrant({ ...base, amount: 1.5 })).toBe("amount_invalid");
		expect(
			validateBulkGrant({ ...base, amount: ADMIN_CREDIT_GRANT_MAX + 1 }),
		).toBe("amount_invalid");
	});

	it("期間が逆転・同時刻・非数は range_invalid", () => {
		expect(validateBulkGrant({ ...base, fromMs: 2_000, toMs: 1_000 })).toBe(
			"range_invalid",
		);
		expect(validateBulkGrant({ ...base, fromMs: 1_000, toMs: 1_000 })).toBe(
			"range_invalid",
		);
		expect(validateBulkGrant({ ...base, toMs: Number.NaN })).toBe(
			"range_invalid",
		);
	});
});

describe("bulkGrantSubrequestBudget", () => {
	// 上限件数は単独では決まらない。「上限件数 × 1ユーザあたりのD1呼び出し回数」が
	// Workers のサブリクエスト上限(1,000)を下回っている必要がある(#253)。
	it("直列ループ相当(1ユーザ6回)は上限を超える — これが #253 の状態", () => {
		const budget = bulkGrantSubrequestBudget(6);
		expect(budget.total).toBe(1200);
		expect(budget.withinLimit).toBe(false);
	});

	it("セットベース化後(1ユーザ1回未満)は上限に収まる", () => {
		// 実装は読み取りをセットベースにし、書き込みを db.batch(=1サブリクエスト)へ
		// 畳むため、1ユーザあたりのD1呼び出しは1回を大きく下回る
		expect(bulkGrantSubrequestBudget(1).withinLimit).toBe(true);
		expect(bulkGrantSubrequestBudget(4).withinLimit).toBe(true);
		// 境界: 5回/人だと 1,000 ちょうどで上限を下回らない
		expect(bulkGrantSubrequestBudget(5).total).toBe(1000);
		expect(bulkGrantSubrequestBudget(5).withinLimit).toBe(false);
	});
});
