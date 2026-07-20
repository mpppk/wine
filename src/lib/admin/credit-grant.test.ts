import { describe, expect, it } from "vitest";
import {
	ADMIN_CREDIT_GRANT_MAX,
	ADMIN_CREDIT_GRANT_MIN,
	validateGrantAmount,
} from "./credit-grant";

describe("validateGrantAmount", () => {
	it("最小値・最大値・その間の整数は有効", () => {
		expect(validateGrantAmount(ADMIN_CREDIT_GRANT_MIN)).toBeNull();
		expect(validateGrantAmount(ADMIN_CREDIT_GRANT_MAX)).toBeNull();
		expect(validateGrantAmount(100)).toBeNull();
	});

	it("0以下は too_small", () => {
		expect(validateGrantAmount(0)).toBe("too_small");
		expect(validateGrantAmount(-1)).toBe("too_small");
		expect(validateGrantAmount(ADMIN_CREDIT_GRANT_MIN - 1)).toBe("too_small");
	});

	it("上限超過は too_large", () => {
		expect(validateGrantAmount(ADMIN_CREDIT_GRANT_MAX + 1)).toBe("too_large");
		expect(validateGrantAmount(1_000_000)).toBe("too_large");
	});

	it("非整数は not_integer", () => {
		expect(validateGrantAmount(1.5)).toBe("not_integer");
		expect(validateGrantAmount(Number.NaN)).toBe("not_integer");
		expect(validateGrantAmount(Number.POSITIVE_INFINITY)).toBe("not_integer");
	});
});
