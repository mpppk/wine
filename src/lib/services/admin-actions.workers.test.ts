import { eq } from "drizzle-orm";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { adminAuditLog, couponRedemption } from "#/db/schema";

// D1(実SQLite)上で、副作用を伴う管理操作の「証跡」を検証する(#251)。
// better-auth と Stripe は外部副作用なのでモックし、D1 への記録とログ出力だけを見る。

const banUserApi = vi.fn();
const unbanUserApi = vi.fn();
const revokeUserSessionsApi = vi.fn();
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			banUser: (...args: unknown[]) => banUserApi(...args),
			unbanUser: (...args: unknown[]) => unbanUserApi(...args),
			revokeUserSessions: (...args: unknown[]) =>
				revokeUserSessionsApi(...args),
		},
	},
}));

const extendPremiumTrial = vi.fn();
vi.mock("#/lib/services/billing-service", () => ({
	extendPremiumTrial: (...args: unknown[]) => extendPremiumTrial(...args),
	isPremiumUser: vi.fn(),
}));

const adminActions = await import("./admin-actions");

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `admin-actions-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "admin actions tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

async function auditRows(targetUserId: string) {
	return db
		.select()
		.from(adminAuditLog)
		.where(eq(adminAuditLog.targetUserId, targetUserId));
}

type ConsoleSpy = MockInstance<(...args: unknown[]) => void>;

/** 構造化ログ(1行JSON)を msg で拾う。 */
function loggedLines(spy: ConsoleSpy, msg: string) {
	return spy.mock.calls
		.map(([line]) => {
			try {
				return JSON.parse(String(line)) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((o): o is Record<string, unknown> => o?.msg === msg);
}

let infoSpy: ConsoleSpy;
let errorSpy: ConsoleSpy;

beforeEach(() => {
	vi.clearAllMocks();
	extendPremiumTrial.mockResolvedValue({
		newPeriodEnd: 1_800_000_000_000,
		stripeSubscriptionId: "sub_test",
	});
	infoSpy = vi
		.spyOn(console, "info")
		.mockImplementation(() => {}) as ConsoleSpy;
	errorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => {}) as ConsoleSpy;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("banUser", () => {
	it("bans through better-auth and records the audit trail", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		const headers = new Headers({ cookie: "session=x" });

		await adminActions.banUser({
			actorUserId: actor,
			targetUserId: target,
			reason: "規約違反",
			expiresInDays: 3,
			headers,
		});

		// 日数は better-auth の秒指定へ変換して渡す。
		expect(banUserApi).toHaveBeenCalledWith({
			body: {
				userId: target,
				banReason: "規約違反",
				banExpiresIn: 3 * 24 * 60 * 60,
			},
			headers,
		});
		const rows = await auditRows(target);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("ban");
		expect(rows[0]?.actorUserId).toBe(actor);
		expect(rows[0]?.reason).toBe("規約違反");
		expect(rows[0]?.detail).toEqual({ banExpiresInDays: 3 });
	});

	it("rejects self-ban before touching better-auth", async () => {
		// 業務判定はサービス層にある(server fn を経由しなくても効く)。
		const actor = await freshUser();
		await expect(
			adminActions.banUser({
				actorUserId: actor,
				targetUserId: actor,
				reason: "誤操作",
				headers: new Headers(),
			}),
		).rejects.toThrow(/自分自身/);
		expect(banUserApi).not.toHaveBeenCalled();
		expect(await auditRows(actor)).toHaveLength(0);
	});

	it("logs the applied action with actor, target and detail", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		await adminActions.banUser({
			actorUserId: actor,
			targetUserId: target,
			reason: "規約違反",
			headers: new Headers(),
		});
		const lines = loggedLines(infoSpy, "admin action applied");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			actorUserId: actor,
			targetUserId: target,
			action: "ban",
			reason: "規約違反",
			detail: { banExpiresInDays: null },
		});
	});

	it("reports the audit gap and rethrows when recording fails", async () => {
		// 記録だけが落ちるケース。BAN は適用済みなので、ログが唯一の証跡になる。
		const actor = await freshUser();
		const target = await freshUser();
		vi.spyOn(db, "insert").mockImplementationOnce(() => {
			throw new Error("D1_ERROR: no such table");
		});

		await expect(
			adminActions.banUser({
				actorUserId: actor,
				targetUserId: target,
				reason: "規約違反",
				expiresInDays: 7,
				headers: new Headers(),
			}),
		).rejects.toThrow(/D1_ERROR/);

		expect(banUserApi).toHaveBeenCalledOnce();
		expect(await auditRows(target)).toHaveLength(0);
		const lines = loggedLines(
			errorSpy,
			"admin audit record failed; action already applied",
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			actorUserId: actor,
			targetUserId: target,
			action: "ban",
			reason: "規約違反",
			detail: { banExpiresInDays: 7 },
		});
		// 原因(D1のエラー)も同じ行に残す。
		expect(String(lines[0]?.err)).toContain("D1_ERROR");
	});
});

describe("unbanUser / revokeSessions", () => {
	it("records unban", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		const headers = new Headers();
		await adminActions.unbanUser({
			actorUserId: actor,
			targetUserId: target,
			reason: "誤BANの解除",
			headers,
		});
		expect(unbanUserApi).toHaveBeenCalledWith({
			body: { userId: target },
			headers,
		});
		expect((await auditRows(target))[0]?.action).toBe("unban");
	});

	it("records session revocation", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		await adminActions.revokeSessions({
			actorUserId: actor,
			targetUserId: target,
			reason: "乗っ取り疑い",
			headers: new Headers(),
		});
		expect(revokeUserSessionsApi).toHaveBeenCalledOnce();
		expect((await auditRows(target))[0]?.action).toBe("revoke_sessions");
	});

	it("reports the audit gap when recording a session revocation fails", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		vi.spyOn(db, "insert").mockImplementationOnce(() => {
			throw new Error("D1_ERROR: network");
		});
		await expect(
			adminActions.revokeSessions({
				actorUserId: actor,
				targetUserId: target,
				reason: "乗っ取り疑い",
				headers: new Headers(),
			}),
		).rejects.toThrow(/D1_ERROR/);
		expect(
			loggedLines(
				errorSpy,
				"admin audit record failed; action already applied",
			),
		).toHaveLength(1);
	});
});

describe("revokeMcp", () => {
	it("records how many tokens and consents were deleted", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		const res = await adminActions.revokeMcp({
			actorUserId: actor,
			targetUserId: target,
			reason: "連携アプリの事故",
		});
		expect(res).toEqual({ tokensDeleted: 0, consentsDeleted: 0 });
		const rows = await auditRows(target);
		expect(rows[0]?.action).toBe("revoke_mcp");
		expect(rows[0]?.detail).toEqual({ tokensDeleted: 0, consentsDeleted: 0 });
	});
});

describe("extendPremium", () => {
	it("records the extension in coupon_redemption and the audit log", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		const res = await adminActions.extendPremium({
			actorUserId: actor,
			targetUserId: target,
			days: 5,
			reason: "障害のお詫び",
		});
		expect(res.extendedDays).toBe(5);

		const coupons = await db
			.select()
			.from(couponRedemption)
			.where(eq(couponRedemption.userId, target));
		expect(coupons).toHaveLength(1);
		expect(coupons[0]?.code).toMatch(/^admin:/);

		const rows = await auditRows(target);
		expect(rows[0]?.action).toBe("premium_extension");
		expect(rows[0]?.detail).toMatchObject({
			days: 5,
			stripeSubscriptionId: "sub_test",
		});
	});

	it("keeps stripe's applied extension traceable when the write fails", async () => {
		// Stripe は延長済みで補償もできない。記録が落ちたら内容ごとログに残す必要がある。
		const actor = await freshUser();
		const target = await freshUser();
		vi.spyOn(db, "batch").mockRejectedValueOnce(
			new Error("D1_ERROR: batch failed"),
		);

		await expect(
			adminActions.extendPremium({
				actorUserId: actor,
				targetUserId: target,
				days: 5,
				reason: "障害のお詫び",
			}),
		).rejects.toThrow(/D1_ERROR/);

		expect(await auditRows(target)).toHaveLength(0);
		const lines = loggedLines(
			errorSpy,
			"admin audit record failed; action already applied",
		);
		expect(lines).toHaveLength(1);
		// 対象・日数・Stripe のサブスクIDが揃っていないと、Stripe 側の適用と突き合わせられない。
		expect(lines[0]).toMatchObject({
			actorUserId: actor,
			targetUserId: target,
			action: "premium_extension",
			detail: { days: 5, stripeSubscriptionId: "sub_test" },
		});
	});
});
