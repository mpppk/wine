import { describe, expect, it } from "vitest";
import {
	BAN_EXPIRES_MAX_DAYS,
	BAN_EXPIRES_MIN_DAYS,
	validateBanExpiresDays,
} from "./moderation";

describe("validateBanExpiresDays", () => {
	it("最小値・最大値・その間の整数は有効", () => {
		expect(validateBanExpiresDays(BAN_EXPIRES_MIN_DAYS)).toBeNull();
		expect(validateBanExpiresDays(BAN_EXPIRES_MAX_DAYS)).toBeNull();
		expect(validateBanExpiresDays(30)).toBeNull();
	});

	it("0以下は too_small", () => {
		expect(validateBanExpiresDays(0)).toBe("too_small");
		expect(validateBanExpiresDays(-1)).toBe("too_small");
	});

	it("上限超過は too_large", () => {
		expect(validateBanExpiresDays(BAN_EXPIRES_MAX_DAYS + 1)).toBe("too_large");
	});

	it("非整数は not_integer", () => {
		expect(validateBanExpiresDays(1.5)).toBe("not_integer");
		expect(validateBanExpiresDays(Number.NaN)).toBe("not_integer");
	});
});
