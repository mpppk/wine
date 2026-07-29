import { describe, expect, it } from "vitest";
import { APP_TIME_ZONE, formatDateJst, formatDateTimeJst } from "./display";

// 表示用の日時整形は実行環境のTZに依存してはいけない(#244)。
//
// workerd の既定TZは UTC、ブラウザは端末TZ。timeZone 未指定だと同じ Date が
// SSR とハイドレーション後で別の文字列になり、hydration mismatch を起こす。
// 以下のケースは **UTCで整形すると前日になる時刻** を使っているため、
// timeZone 指定が外れると(CI/開発機はUTC)必ず落ちる。

describe("formatDateJst", () => {
	it("UTCでは前日になる時刻でも JST の暦日で整形する", () => {
		// 2026-07-27T23:00:00Z = JST 2026-07-28 08:00
		expect(formatDateJst(new Date("2026-07-27T23:00:00Z"))).toBe("2026/7/28");
	});

	it("JSTの日中はそのままの暦日", () => {
		// 2026-07-28T03:00:00Z = JST 2026-07-28 12:00
		expect(formatDateJst(new Date("2026-07-28T03:00:00Z"))).toBe("2026/7/28");
	});

	it("年をまたぐ境界も JST で判定する", () => {
		// 2026-12-31T20:00:00Z = JST 2027-01-01 05:00
		expect(formatDateJst(new Date("2026-12-31T20:00:00Z"))).toBe("2027/1/1");
	});
});

describe("formatDateTimeJst", () => {
	it("UTCでは前日になる時刻を JST の日時で整形する", () => {
		// 2026-07-27T23:00:00Z = JST 2026-07-28 08:00:00
		expect(formatDateTimeJst(new Date("2026-07-27T23:00:00Z"))).toBe(
			"2026/7/28 8:00:00",
		);
	});
});

describe("APP_TIME_ZONE", () => {
	it("アプリの時刻規約(JST)と揃っている", () => {
		expect(APP_TIME_ZONE).toBe("Asia/Tokyo");
	});
});
