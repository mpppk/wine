import { describe, expect, it } from "vitest";
import { isAdminSession } from "./guard";

type Session = Parameters<typeof isAdminSession>[0];

// 予測子は session.user.role と session.user.banned しか見ないため、
// 必要な形だけを持つ最小オブジェクトを Session として渡す。
function session(role: string, banned: boolean | null | undefined): Session {
	return { user: { role, banned } } as unknown as Session;
}

describe("isAdminSession", () => {
	it("未ログイン(null)は管理者ではない", () => {
		expect(isAdminSession(null)).toBe(false);
	});

	it("role が admin 以外は管理者ではない", () => {
		expect(isAdminSession(session("user", false))).toBe(false);
		expect(isAdminSession(session("user", null))).toBe(false);
	});

	it("role=admin かつ BAN されていなければ管理者", () => {
		expect(isAdminSession(session("admin", false))).toBe(true);
		expect(isAdminSession(session("admin", null))).toBe(true);
		expect(isAdminSession(session("admin", undefined))).toBe(true);
	});

	it("BAN された管理者は管理者とみなさない(banned のドリフト回帰防止)", () => {
		expect(isAdminSession(session("admin", true))).toBe(false);
	});
});
