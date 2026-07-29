import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./format";

// 管理画面の日時は JST 固定で描画する(#244)。ここが端末TZ/UTC依存に戻ると、
// SSR(workerd=UTC)とハイドレーション後で文字列が食い違い、登録日時が9時間前に見える。
// 以下は UTC で整形すると前日になる時刻を使っているため、TZ指定が外れると落ちる。

describe("管理画面の日時整形", () => {
	it("formatDateTime は JST で整形する", () => {
		// 2026-07-27T23:00:00Z = JST 2026-07-28 08:00
		expect(formatDateTime(new Date("2026-07-27T23:00:00Z"))).toBe(
			"2026/7/28 8:00:00",
		);
	});

	it("formatDate は JST の暦日で整形する", () => {
		expect(formatDate(new Date("2026-07-27T23:00:00Z"))).toBe("2026/7/28");
	});

	it("formatDate は null を '-' にする", () => {
		expect(formatDate(null)).toBe("-");
	});
});
