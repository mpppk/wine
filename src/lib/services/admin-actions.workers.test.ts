import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import {
	adminAuditLog,
	couponRedemption,
	creditBalance,
	creditLedger,
} from "#/db/schema";

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
	// 一括付与のセットベース版が使う(#253)。プレミアム無しとして扱う
	listPremiumUserIds: vi.fn(async () => new Set<string>()),
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

// #253 の回帰。一括付与は最大200ユーザで、直列ループだと1ユーザ約6回のD1呼び出しに
// なり Workers のサブリクエスト上限(1リクエスト1,000。D1もここに計上される)を超えて
// "Too many subrequests" で部分付与になっていた。requestId 冪等なので再実行は安全だが、
// 再実行でも付与済みユーザぶんのクエリを消費するため200人規模では完走できない。
//
// ここでは実D1の呼び出し回数を env.DB の prepare / batch を数えて直接測る。
// **人数に対して線形に増えないこと**が本質なので、人数を変えて2回測って比べる。
describe("bulkGrantCredits のD1呼び出し数", () => {
	// D1 で**サブリクエストとして数えられるのは実際の実行**(prepare した文の
	// run/all/first/raw と batch)であって、prepare 自体はローカルの構築なので数えない。
	// prepare を数えると db.batch に積んだ文まで1件ずつ計上され、実態と合わない。
	async function countD1Calls(userIds: string[], incidentId: string) {
		let executions = 0;
		const realPrepare = env.DB.prepare.bind(env.DB);
		const prepareSpy = vi
			.spyOn(env.DB, "prepare")
			.mockImplementation((query: string) => {
				const stmt = realPrepare(query);
				return new Proxy(stmt, {
					get(target, prop, receiver) {
						const value = Reflect.get(target, prop, receiver);
						if (
							typeof value === "function" &&
							(prop === "all" ||
								prop === "run" ||
								prop === "first" ||
								prop === "raw")
						) {
							return (...args: unknown[]) => {
								executions += 1;
								return (value as (...a: unknown[]) => unknown).apply(
									target,
									args,
								);
							};
						}
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			});
		const batchSpy = vi.spyOn(env.DB, "batch");
		try {
			await adminActions.bulkGrantCredits({
				actorUserId: "admin-bulk-actor",
				incidentId,
				userIds,
				amount: 3,
				reason: "検証",
			});
			return executions + batchSpy.mock.calls.length;
		} finally {
			prepareSpy.mockRestore();
			batchSpy.mockRestore();
		}
	}

	it("対象人数に対して線形に増えず、上限200人でもサブリクエスト上限に収まる", async () => {
		const few: string[] = [];
		for (let i = 0; i < 4; i++) few.push(await freshUser());
		const many: string[] = [];
		for (let i = 0; i < 24; i++) many.push(await freshUser());

		const callsFew = await countD1Calls(few, "incident-few");
		const callsMany = await countD1Calls(many, "incident-many");

		// 6倍の人数でも呼び出し回数はほぼ変わらない(直列ループなら6倍に増える)
		expect(callsMany).toBeLessThan(callsFew * 2);
		// 200人へ外挿しても上限1,000に十分収まる
		const perUser = (callsMany - callsFew) / (many.length - few.length);
		expect(200 * perUser + callsFew).toBeLessThan(1000);
	});

	it("全員に加算され、再実行しても二重加算しない(冪等)", async () => {
		const users: string[] = [];
		for (let i = 0; i < 5; i++) users.push(await freshUser());

		const first = await adminActions.bulkGrantCredits({
			actorUserId: "admin-bulk-actor",
			incidentId: "incident-idem",
			userIds: users,
			amount: 7,
			reason: "検証",
		});
		expect(first.granted).toBe(5);
		expect(first.alreadyApplied).toBe(0);

		const balances = await db
			.select({ userId: creditBalance.userId, balance: creditBalance.balance })
			.from(creditBalance);
		const byUser = new Map(balances.map((r) => [r.userId, r.balance]));
		const afterFirst = users.map((u) => byUser.get(u));
		for (const b of afterFirst) expect(b).toBeGreaterThanOrEqual(7);

		const second = await adminActions.bulkGrantCredits({
			actorUserId: "admin-bulk-actor",
			incidentId: "incident-idem",
			userIds: users,
			amount: 7,
			reason: "検証(再実行)",
		});
		expect(second.granted).toBe(0);
		expect(second.alreadyApplied).toBe(5);

		const after = await db
			.select({ userId: creditBalance.userId, balance: creditBalance.balance })
			.from(creditBalance);
		const byUser2 = new Map(after.map((r) => [r.userId, r.balance]));
		expect(users.map((u) => byUser2.get(u))).toEqual(afterFirst);

		// 台帳も1ユーザ1行のまま
		const ledger = await db
			.select({ requestId: creditLedger.requestId })
			.from(creditLedger);
		const adminRows = ledger.filter((r) =>
			r.requestId?.startsWith("admin_grant:incident-idem:"),
		);
		expect(adminRows.length).toBe(5);
	});
});

describe("grantCredits の冪等性", () => {
	it("同一 requestId の再送は加算も監査追記もせず、alreadyApplied で返す", async () => {
		const targetUserId = await freshUser();
		// 実運用では管理画面のリトライ・二重クリックがこの形で届く
		const requestId = `admin_grant:${crypto.randomUUID()}`;

		const first = await adminActions.grantCredits({
			actorUserId: "admin-grant-actor",
			targetUserId,
			amount: 30,
			reason: "障害のお詫び",
			requestId,
		});
		expect(first.alreadyApplied).toBe(false);

		const second = await adminActions.grantCredits({
			actorUserId: "admin-grant-actor",
			targetUserId,
			amount: 30,
			reason: "障害のお詫び(再送)",
			requestId,
		});

		expect(second.alreadyApplied).toBe(true);
		// 残高が動いていないこと。ここが崩れると再送のたびに二重付与になる
		expect(second.balanceAfter).toBe(first.balanceAfter);

		const adminRows = (
			await db
				.select({ requestId: creditLedger.requestId })
				.from(creditLedger)
				.where(eq(creditLedger.userId, targetUserId))
		).filter((r) => r.requestId === requestId);
		expect(adminRows).toHaveLength(1);

		// 監査ログも1件のまま(付与していないのに「付与した」記録が増えない)
		const audits = (await auditRows(targetUserId)).filter(
			(r) => r.action === "credit_grant",
		);
		expect(audits).toHaveLength(1);
	});

	it("requestId が異なれば別の付与として加算する", async () => {
		const targetUserId = await freshUser();

		const first = await adminActions.grantCredits({
			actorUserId: "admin-grant-actor",
			targetUserId,
			amount: 10,
			reason: "1回目",
			requestId: `admin_grant:${crypto.randomUUID()}`,
		});
		const second = await adminActions.grantCredits({
			actorUserId: "admin-grant-actor",
			targetUserId,
			amount: 10,
			reason: "2回目",
			requestId: `admin_grant:${crypto.randomUUID()}`,
		});

		expect(second.alreadyApplied).toBe(false);
		expect(second.balanceAfter).toBe(first.balanceAfter + 10);
	});
});
