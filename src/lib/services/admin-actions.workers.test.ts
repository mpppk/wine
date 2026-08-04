import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import {
	oauthAccessToken,
	oauthApplication,
	oauthConsent,
	user,
} from "#/db/auth-schema";
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

/**
 * MCP(OAuth)連携済みのユーザを作る。BAN 連動失効(#330)の検証に使う。
 * oauth_access_token / oauth_consent は client_id で oauth_application を参照する。
 */
async function withMcpConnection(userId: string): Promise<void> {
	const clientId = `client-${userId}`;
	const now = new Date();
	await db.insert(oauthApplication).values({
		id: `app-${userId}`,
		name: "test mcp client",
		clientId,
		redirectUrls: "https://example.com/callback",
		type: "web",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthAccessToken).values({
		id: `token-${userId}`,
		accessToken: `at-${userId}`,
		refreshToken: `rt-${userId}`,
		accessTokenExpiresAt: new Date(now.getTime() + 3_600_000),
		refreshTokenExpiresAt: new Date(now.getTime() + 604_800_000),
		clientId,
		userId,
		scopes: "openid profile",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthConsent).values({
		id: `consent-${userId}`,
		clientId,
		userId,
		scopes: "openid profile",
		consentGiven: true,
		createdAt: now,
		updatedAt: now,
	});
}

async function mcpRowCounts(userId: string) {
	const tokens = await db
		.select({ id: oauthAccessToken.id })
		.from(oauthAccessToken)
		.where(eq(oauthAccessToken.userId, userId));
	const consents = await db
		.select({ id: oauthConsent.id })
		.from(oauthConsent)
		.where(eq(oauthConsent.userId, userId));
	return { tokens: tokens.length, consents: consents.length };
}

/** 一括付与の検証用: userId → 残高。 */
async function balanceByUser(userIds: string[]): Promise<Map<string, number>> {
	const rows = await db
		.select({ userId: creditBalance.userId, balance: creditBalance.balance })
		.from(creditBalance);
	const set = new Set(userIds);
	return new Map(
		rows.filter((r) => set.has(r.userId)).map((r) => [r.userId, r.balance]),
	);
}

/**
 * 一括付与の検証用: 月次付与ぶん(admin_grant を除く台帳の合計)。
 * 「残高が動いたか」を admin_grant の有無と独立に判定するための基準値。
 */
async function grantedBaseline(
	userIds: string[],
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			userId: creditLedger.userId,
			amount: creditLedger.amount,
			type: creditLedger.type,
		})
		.from(creditLedger);
	const set = new Set(userIds);
	const out = new Map<string, number>();
	for (const r of rows) {
		if (!set.has(r.userId) || r.type === "admin_grant") continue;
		out.set(r.userId, (out.get(r.userId) ?? 0) + r.amount);
	}
	return out;
}

/** 一括付与の検証用: incidentId の admin_grant 台帳の userId → 合計額。 */
async function adminGrantAmounts(
	incidentId: string,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			userId: creditLedger.userId,
			amount: creditLedger.amount,
			requestId: creditLedger.requestId,
		})
		.from(creditLedger);
	const prefix = `admin_grant:${incidentId}:`;
	const out = new Map<string, number>();
	for (const r of rows) {
		if (!r.requestId?.startsWith(prefix)) continue;
		out.set(r.userId, (out.get(r.userId) ?? 0) + r.amount);
	}
	return out;
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
		expect(rows[0]?.detail).toEqual({
			banExpiresInDays: 3,
			mcpRevoked: true,
			mcpTokensDeleted: 0,
			mcpConsentsDeleted: 0,
		});
	});

	// #330: BAN は Web セッションだけでなく MCP(OAuth)連携も断つ。ここが抜けると
	// 停止したユーザが MCP 経由で書き込みと AI クレジット消費を続けられる。
	it("revokes the target's MCP tokens and consents", async () => {
		const actor = await freshUser();
		const target = await freshUser();
		const bystander = await freshUser();
		await withMcpConnection(target);
		await withMcpConnection(bystander);

		await adminActions.banUser({
			actorUserId: actor,
			targetUserId: target,
			reason: "MCP経由の濫用",
			headers: new Headers(),
		});

		expect(await mcpRowCounts(target)).toEqual({ tokens: 0, consents: 0 });
		// 他ユーザの連携は巻き込まない
		expect(await mcpRowCounts(bystander)).toEqual({ tokens: 1, consents: 1 });
		expect((await auditRows(target))[0]?.detail).toEqual({
			banExpiresInDays: null,
			mcpRevoked: true,
			mcpTokensDeleted: 1,
			mcpConsentsDeleted: 1,
		});
	});

	it("still records the ban when revoking MCP connections fails", async () => {
		// 失効が落ちても BAN は適用済み。ここで throw すると「BAN 適用済み・監査ログ無し」
		// になるため、失効できなかったことを証跡に残して処理を続ける
		// (アクセス自体は /api/mcp の入口ガードが拒否する)。
		const actor = await freshUser();
		const target = await freshUser();
		vi.spyOn(db, "batch").mockImplementationOnce(() => {
			throw new Error("D1_ERROR: network");
		});

		await adminActions.banUser({
			actorUserId: actor,
			targetUserId: target,
			reason: "規約違反",
			headers: new Headers(),
		});

		expect((await auditRows(target))[0]?.detail).toEqual({
			banExpiresInDays: null,
			mcpRevoked: false,
			mcpTokensDeleted: null,
			mcpConsentsDeleted: null,
		});
		const lines = loggedLines(
			errorSpy,
			"ban applied but revoking mcp connections failed",
		);
		expect(lines).toHaveLength(1);
		expect(String(lines[0]?.err)).toContain("D1_ERROR");
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
			detail: { banExpiresInDays: null, mcpRevoked: true },
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
			detail: { banExpiresInDays: 7, mcpRevoked: true },
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

	// #334: 1ユーザ3文をフラットに 100 文で切っていたため、チャンク境界のユーザ
	// (34人目)だけ「残高加算」と「台帳追記」が別トランザクションに割れていた。後段の
	// チャンクが落ちると残高だけ増えて台帳行が無い状態になり、同一 incidentId の
	// 冪等リトライ(復旧手段)がそのユーザを pending に含めて二重加算する。
	it("途中のチャンクが失敗しても、残高だけ動いて台帳行が無いユーザを作らない", async () => {
		// チャンク境界(34人目)を跨ぐ人数
		const users: string[] = [];
		for (let i = 0; i < 40; i++) users.push(await freshUser());
		const incidentId = "incident-chunk-boundary";
		const amount = 11;

		// 付与本体の2つ目のバッチだけ失敗させる(1つ目は ensureCurrentMonthGrantedMany)。
		const realBatch = db.batch.bind(db);
		let batchCalls = 0;
		const batchSpy = vi
			.spyOn(db, "batch")
			.mockImplementation((...args: Parameters<typeof db.batch>) => {
				batchCalls += 1;
				if (batchCalls === 3) throw new Error("D1_ERROR: chunk failed");
				return realBatch(...args);
			});

		await expect(
			adminActions.bulkGrantCredits({
				actorUserId: "admin-bulk-actor",
				incidentId,
				userIds: users,
				amount,
				reason: "障害補填",
			}),
		).rejects.toThrow(/D1_ERROR/);
		batchSpy.mockRestore();
		// 前提: 付与が複数バッチに割れていること(1バッチなら境界を検証できていない)
		expect(batchCalls).toBeGreaterThanOrEqual(3);

		const monthlyGrant = await grantedBaseline(users);
		const ledgerFor = await adminGrantAmounts(incidentId);
		const balances = await balanceByUser(users);

		// 不変条件: 残高が動いたユーザには必ず台帳行がある
		const inconsistent = users.filter(
			(u) =>
				(balances.get(u) ?? 0) - (monthlyGrant.get(u) ?? 0) !== 0 &&
				!ledgerFor.has(u),
		);
		expect(inconsistent).toEqual([]);

		// 復旧: 同一 incidentId で再実行すると、未付与のユーザだけが1回付与される
		const retry = await adminActions.bulkGrantCredits({
			actorUserId: "admin-bulk-actor",
			incidentId,
			userIds: users,
			amount,
			reason: "障害補填(再実行)",
		});
		expect(retry.granted + retry.alreadyApplied).toBe(users.length);

		const afterBalances = await balanceByUser(users);
		const afterLedger = await adminGrantAmounts(incidentId);
		for (const u of users) {
			// 全員ちょうど1回ぶん(二重加算していない)
			expect(afterLedger.get(u)).toBe(amount);
			expect((afterBalances.get(u) ?? 0) - (monthlyGrant.get(u) ?? 0)).toBe(
				amount,
			);
		}
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

	// Issue #403: ensureCurrentMonthGranted で当月へ揃えた後、db.batch のコミットまでの間に
	// 別リクエストの月次リセット(月替わり)が割り込む競合。残高UPDATEに月境界ガードが
	// 無いと、**翌月のリセット済み残高**に当月ぶんの補填が乗り、案A(当月末まで有効)の
	// 下で1ヶ月余分に生存する。settle/refund は同じ競合を月境界ガードで塞いでいる(#147)。
	it("コミット直前に月が替わっていたら、残高へ加算せず台帳だけ残す(#403)", async () => {
		const targetUserId = await freshUser();
		const NEXT_MONTH = "2999-12";
		const RESET_BALANCE = 7;
		const realBatch = db.batch.bind(db);
		// 残高行が無いユーザなので、grantCredits が投げる db.batch は
		// 1回目 = ensureCurrentMonthGranted の初回付与、2回目 = 付与本体。
		// 付与本体のコミット直前だけに割り込ませる(db.batch は本物を走らせ、
		// ガードが実クエリで効いていることを見る)。
		let batchCalls = 0;
		const spy = vi.spyOn(db, "batch").mockImplementation((async (
			statements: Parameters<typeof db.batch>[0],
		) => {
			batchCalls += 1;
			if (batchCalls === 2) {
				await db
					.update(creditBalance)
					.set({ balance: RESET_BALANCE, periodMonth: NEXT_MONTH })
					.where(eq(creditBalance.userId, targetUserId));
			}
			return realBatch(statements);
		}) as unknown as typeof db.batch);

		try {
			await adminActions.grantCredits({
				actorUserId: "admin-grant-actor",
				targetUserId,
				amount: 300,
				reason: "障害のお詫び",
			});
		} finally {
			spy.mockRestore();
		}

		// 台帳には補填が残るが、翌月のリセット済み残高には乗らない。
		const grants = (
			await db
				.select()
				.from(creditLedger)
				.where(eq(creditLedger.userId, targetUserId))
		).filter((r) => r.type === "admin_grant");
		expect(grants).toHaveLength(1);
		const balance = await db
			.select({ balance: creditBalance.balance })
			.from(creditBalance)
			.where(eq(creditBalance.userId, targetUserId));
		expect(balance[0]?.balance).toBe(RESET_BALANCE);
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
