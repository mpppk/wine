import { describe, expect, it } from "vitest";
import {
	isImpersonatedSession,
	isImpersonationWriteBlocked,
	isWriteRequest,
} from "./impersonation";

type Session = Parameters<typeof isImpersonatedSession>[0];

// 予測子は session.session.impersonatedBy しか見ないため、必要な形だけを渡す。
function session(impersonatedBy: string | null | undefined): Session {
	return { session: { impersonatedBy } } as unknown as Session;
}

describe("isImpersonatedSession", () => {
	it("未ログイン(null)はなりすましではない", () => {
		expect(isImpersonatedSession(null)).toBe(false);
	});

	it("impersonatedBy が無い通常セッションはなりすましではない", () => {
		expect(isImpersonatedSession(session(null))).toBe(false);
		expect(isImpersonatedSession(session(undefined))).toBe(false);
	});

	it("impersonatedBy に操作元 admin の id が入っていればなりすまし", () => {
		expect(isImpersonatedSession(session("admin-1"))).toBe(true);
	});
});

describe("isWriteRequest", () => {
	it("GET / HEAD は書き込みではない(大文字小文字を問わない)", () => {
		expect(isWriteRequest("GET")).toBe(false);
		expect(isWriteRequest("get")).toBe(false);
		expect(isWriteRequest("HEAD")).toBe(false);
		expect(isWriteRequest("head")).toBe(false);
	});

	it("POST / PUT / PATCH / DELETE は書き込み", () => {
		expect(isWriteRequest("POST")).toBe(true);
		expect(isWriteRequest("post")).toBe(true);
		expect(isWriteRequest("PUT")).toBe(true);
		expect(isWriteRequest("PATCH")).toBe(true);
		expect(isWriteRequest("DELETE")).toBe(true);
	});

	it("未知のメソッドは既定で書き込み扱い(拒否側に倒す)", () => {
		expect(isWriteRequest("QUERY")).toBe(true);
		expect(isWriteRequest("")).toBe(true);
	});
});

describe("isImpersonationWriteBlocked", () => {
	it("なりすまし中の書き込みだけを拒否する", () => {
		expect(isImpersonationWriteBlocked(session("admin-1"), "POST")).toBe(true);
		expect(isImpersonationWriteBlocked(session("admin-1"), "DELETE")).toBe(
			true,
		);
	});

	it("なりすまし中でも閲覧(GET)は通す", () => {
		expect(isImpersonationWriteBlocked(session("admin-1"), "GET")).toBe(false);
	});

	it("通常セッションの書き込みは通す", () => {
		expect(isImpersonationWriteBlocked(session(null), "POST")).toBe(false);
		expect(isImpersonationWriteBlocked(null, "POST")).toBe(false);
	});
});
