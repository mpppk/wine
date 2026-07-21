import { describe, expect, it } from "vitest";
import { validateBulkGrant } from "./bulk-credit";
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
