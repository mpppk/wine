import { describe, expect, it } from "vitest";
import {
	BAN_EXPIRES_MAX_DAYS,
	BAN_EXPIRES_MIN_DAYS,
	isBanActive,
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

describe("isBanActive", () => {
	const now = new Date("2026-07-30T00:00:00Z");

	it("BANされていなければ false", () => {
		expect(isBanActive({ banned: null, banExpires: null }, now)).toBe(false);
		expect(isBanActive({ banned: false, banExpires: null }, now)).toBe(false);
		// 期限だけ未来に残っていても banned が立っていなければ有効ではない
		expect(
			isBanActive(
				{ banned: false, banExpires: new Date("2026-08-01T00:00:00Z") },
				now,
			),
		).toBe(false);
	});

	it("無期限BANは常に有効", () => {
		expect(isBanActive({ banned: true, banExpires: null }, now)).toBe(true);
	});

	it("期限が未来なら有効", () => {
		expect(
			isBanActive(
				{ banned: true, banExpires: new Date("2026-07-30T00:00:01Z") },
				now,
			),
		).toBe(true);
	});

	it("期限が過ぎていれば無効(サインインを経ない経路でも自動解除する)", () => {
		expect(
			isBanActive(
				{ banned: true, banExpires: new Date("2026-07-29T23:59:59Z") },
				now,
			),
		).toBe(false);
		// 境界(ちょうど期限)は解除側に倒す
		expect(isBanActive({ banned: true, banExpires: now }, now)).toBe(false);
	});
});
