import { describe, expect, it } from "vitest";
import { type RouteSession, toRouteSession } from "./route-session";

// #388: route context に載る形をここで固定する。ここから出たものは SSR HTML の script と
// /_serverFn/* のレスポンスの両方でクライアントに露出するため、「増えていないこと」を
// 検査する側のテストにしてある。

/** better-auth の getSession が返す形(必要な部分だけ)。 */
function fullSession(userOverrides: Record<string, unknown> = {}) {
	return {
		session: {
			id: "sess-1",
			// 以下3つがクライアントへ出てはいけないもの
			token: "raw-session-token",
			ipAddress: "203.0.113.10",
			userAgent: "Mozilla/5.0 (Macintosh)",
			userId: "u1",
			expiresAt: new Date("2026-09-01T00:00:00Z"),
			createdAt: new Date("2026-08-01T00:00:00Z"),
			updatedAt: new Date("2026-08-01T00:00:00Z"),
		},
		user: {
			id: "u1",
			name: "User 1",
			email: "u1@example.com",
			emailVerified: true,
			role: "user",
			banned: false,
			createdAt: new Date("2026-07-01T00:00:00Z"),
			updatedAt: new Date("2026-07-01T00:00:00Z"),
			...userOverrides,
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: better-auth の完全な型を組み立てずに変換だけ試す
const convert = (s: unknown) => toRouteSession(s as any);

describe("toRouteSession", () => {
	it("未ログインは null", () => {
		expect(convert(null)).toBeNull();
	});

	it("公開してよいフィールドだけを返す", () => {
		expect(convert(fullSession())).toEqual({
			userId: "u1",
			userName: "User 1",
			isAdmin: false,
		} satisfies RouteSession);
	});

	// キーの集合そのものを固定する。生セッションを綴じ込んだ実装に戻したり、
	// 秘匿値を持つフィールドを足したら落ちる。
	it("キーが3つから増えていない", () => {
		expect(Object.keys(convert(fullSession()) ?? {}).sort()).toEqual([
			"isAdmin",
			"userId",
			"userName",
		]);
	});

	it("セッショントークン・IP・UA・メールアドレスを含まない", () => {
		const serialized = JSON.stringify(convert(fullSession()));
		expect(serialized).not.toContain("raw-session-token");
		expect(serialized).not.toContain("203.0.113.10");
		expect(serialized).not.toContain("Mozilla/5.0");
		expect(serialized).not.toContain("u1@example.com");
	});

	it("表示名未設定は null になる", () => {
		expect(convert(fullSession({ name: null }))?.userName).toBeNull();
	});

	// isAdmin は isAdminSession(adminMiddleware と共有の SSOT)の結果であること。
	it("BAN されていない管理者だけ isAdmin=true", () => {
		expect(convert(fullSession({ role: "admin" }))?.isAdmin).toBe(true);
		expect(convert(fullSession({ role: "admin", banned: true }))?.isAdmin).toBe(
			false,
		);
		expect(convert(fullSession({ role: "user" }))?.isAdmin).toBe(false);
	});
});
