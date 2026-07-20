import { describe, expect, it } from "vitest";
import {
	ADMIN_EXTENSION_MAX_DAYS,
	ADMIN_EXTENSION_MIN_DAYS,
	validateExtensionDays,
} from "./premium-extension";

describe("validateExtensionDays", () => {
	it("最小値・最大値・その間の整数は有効", () => {
		expect(validateExtensionDays(ADMIN_EXTENSION_MIN_DAYS)).toBeNull();
		expect(validateExtensionDays(ADMIN_EXTENSION_MAX_DAYS)).toBeNull();
		expect(validateExtensionDays(30)).toBeNull();
	});

	it("0以下は too_small", () => {
		expect(validateExtensionDays(0)).toBe("too_small");
		expect(validateExtensionDays(-1)).toBe("too_small");
	});

	it("上限超過は too_large", () => {
		expect(validateExtensionDays(ADMIN_EXTENSION_MAX_DAYS + 1)).toBe(
			"too_large",
		);
		expect(validateExtensionDays(1000)).toBe("too_large");
	});

	it("非整数は not_integer", () => {
		expect(validateExtensionDays(1.5)).toBe("not_integer");
		expect(validateExtensionDays(Number.NaN)).toBe("not_integer");
	});
});
