import { describe, expect, it } from "vitest";
import {
	REFUND_SUFFIX,
	refundRequestId,
	SETTLE_SUFFIX,
	settleRequestId,
} from "./reservation";

describe("予約IDからの派生キー", () => {
	it("確定・返却の requestId を接尾辞から導く", () => {
		expect(settleRequestId("ask_region:abc")).toBe("ask_region:abc:settle");
		expect(refundRequestId("ask_region:abc")).toBe("ask_region:abc:refund");
	});

	it("接尾辞は互いに異なる(同一キーへ衝突しない)", () => {
		expect(SETTLE_SUFFIX).not.toBe(REFUND_SUFFIX);
	});

	it("孤児予約の補填マイグレーションが使う接尾辞と一致する", async () => {
		// drizzle/0020 は「:settle も :refund も無い consume」を確定済みとして補填する。
		// SQL 側はこのモジュールを import できないため接尾辞をリテラルで書いている。
		// 片方だけ変更すると孤児検出が壊れる(既存の確定済み予約を返却してしまう)ので、
		// 実物のSQLを読んで突き合わせる。
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const sql = await fs.readFile(
			path.resolve(
				process.cwd(),
				"drizzle/0020_credit_settle_marker_backfill.sql",
			),
			"utf8",
		);
		expect(sql).toContain(`|| '${SETTLE_SUFFIX}'`);
		expect(sql).toContain(`|| '${REFUND_SUFFIX}'`);
	});
});
