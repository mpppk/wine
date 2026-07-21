import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditBalance, creditLedger } from "#/db/schema";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import { currentMonthKey } from "#/lib/credit/month";
import {
	ensureCurrentMonthGranted,
	getBalance,
	refundReservation,
	reserveCredits,
	settleReservation,
} from "./credit-service";

// D1(実SQLite)上で credit-service の付与ロジックを検証する。特に月途中のプレミアム
// 昇格で当月クレジットを差分付与する挙動(#142)を、実際にクエリを走らせて確認する。

let seq = 0;
async function freshUser(): Promise<string> {
	seq += 1;
	const id = `credit-test-${seq}`;
	await db.insert(user).values({
		id,
		name: "credit tester",
		email: `${id}@example.com`,
		emailVerified: false,
	});
	return id;
}

/** ユーザを有効なプレミアム会員にする(isPremiumUser が true を返すよう subscription を投入)。 */
async function makePremium(userId: string): Promise<void> {
	await db.insert(subscription).values({
		id: `sub-${userId}`,
		plan: "premium",
		referenceId: userId,
		status: "active",
	});
}

async function ledgerRows(userId: string, type: string) {
	return db
		.select()
		.from(creditLedger)
		.where(and(eq(creditLedger.userId, userId), eq(creditLedger.type, type)));
}

/** 残高キャッシュを直接読む(getBalance と違い遅延付与を発火させない)。 */
async function readBalance(userId: string): Promise<number> {
	const rows = await db
		.select({ balance: creditBalance.balance })
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);
	return rows[0]?.balance ?? 0;
}

async function ledgerByRequestId(requestId: string) {
	return db
		.select()
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId));
}

describe("ensureCurrentMonthGranted", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
	});

	it("無料会員に当月分(FREE)を付与し grant 台帳を1本作る", async () => {
		await ensureCurrentMonthGranted(userId);

		const bal = await getBalance(userId);
		expect(bal.balance).toBe(MONTHLY_CREDITS_FREE);
		expect(bal.periodMonth).toBe(currentMonthKey());

		const grants = await ledgerRows(userId, "grant");
		expect(grants).toHaveLength(1);
		expect(grants[0]?.amount).toBe(MONTHLY_CREDITS_FREE);
		// 昇格していないので grant_upgrade は発生しない。
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(0);
	});

	it("月途中のプレミアム昇格で不足分(PREMIUM-FREE)を差分付与する(#142)", async () => {
		// 無料会員として当月分(FREE)を先に付与済みにする。
		await ensureCurrentMonthGranted(userId);
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_FREE);

		// 月の途中でプレミアムに昇格。
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		// 残高はプレミアムの付与額まで底上げされる。
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);

		const upgrades = await ledgerRows(userId, "grant_upgrade");
		expect(upgrades).toHaveLength(1);
		expect(upgrades[0]?.amount).toBe(
			MONTHLY_CREDITS_PREMIUM - MONTHLY_CREDITS_FREE,
		);
		expect(upgrades[0]?.requestId).toBe(
			`grant_upgrade:${userId}:${currentMonthKey()}`,
		);
	});

	it("差分付与は冪等: 昇格後に再実行しても二重に加算しない", async () => {
		await ensureCurrentMonthGranted(userId);
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);
		// 何度呼んでも残高・台帳は変わらない。
		await ensureCurrentMonthGranted(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(1);
	});

	it("昇格前に消費していても、消費分を巻き戻さずに差分だけ加算する", async () => {
		await ensureCurrentMonthGranted(userId);
		// FREE(50) のうち 30 クレジット分(30,000 トークン)を消費予約する。
		const reserved = await reserveCredits(userId, 30_000, `req-${userId}`);
		expect(reserved.ok).toBe(true);
		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_FREE - 30);

		// 昇格 → 差分(PREMIUM-FREE=450)のみ加算され、消費済みの30は戻らない。
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(
			MONTHLY_CREDITS_FREE -
				30 +
				(MONTHLY_CREDITS_PREMIUM - MONTHLY_CREDITS_FREE),
		);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(1);
	});

	it("プレミアム会員として初回付与された場合は grant_upgrade を発生させない", async () => {
		await makePremium(userId);
		await ensureCurrentMonthGranted(userId);

		expect((await getBalance(userId)).balance).toBe(MONTHLY_CREDITS_PREMIUM);
		const grants = await ledgerRows(userId, "grant");
		expect(grants).toHaveLength(1);
		expect(grants[0]?.amount).toBe(MONTHLY_CREDITS_PREMIUM);
		expect(await ledgerRows(userId, "grant_upgrade")).toHaveLength(0);
	});
});

describe("getBalance / reserveCredits", () => {
	it("残高行が無いユーザでも遅延付与を挟んで残高を返す", async () => {
		const userId = await freshUser();
		const bal = await getBalance(userId);
		expect(bal.balance).toBe(MONTHLY_CREDITS_FREE);
	});
});

describe("reserveCredits の原子性・冪等性 (#143)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("残高不足の予約は残高を引かず consume 台帳も残さない(打ち消し確認)", async () => {
		// FREE=50 に対し 60 クレジット(60,000トークン)を要求 → 不足。
		const requestId = `insufficient-${userId}`;
		const res = await reserveCredits(userId, 60_000, requestId);

		expect(res.ok).toBe(false);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		// batch 内で入った consume 行が打ち消され、痕跡が残らない。
		expect(await ledgerByRequestId(requestId)).toHaveLength(0);
	});

	it("同一 requestId の再予約は二重に引かない(冪等)", async () => {
		const requestId = `dup-${userId}`;
		await reserveCredits(userId, 30_000, requestId);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);

		// 同じ requestId でもう一度呼んでも残高は変わらず、consume 台帳も1本のまま。
		const again = await reserveCredits(userId, 30_000, requestId);
		expect(again.ok).toBe(true);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30);
		expect(await ledgerByRequestId(requestId)).toHaveLength(1);
	});
});

describe("settleReservation のガード (#146/#147)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("確定の差分返却は一度だけ反映し、二重呼び出しで二重加算しない(#146)", async () => {
		const requestId = `settle-${userId}`;
		// 30 クレジット予約(残高 50→20)。実測 10 クレジット → 差分 20 を返却。
		await reserveCredits(userId, 30_000, requestId);
		await settleReservation(userId, requestId, 30, 10_000);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);

		// 同一 requestId の再確定は残高を動かさない。
		await settleReservation(userId, requestId, 30, 10_000);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
	});

	it("予約の月と現残高の月が異なる場合は残高へ加算せず台帳のみ記録する(#147)", async () => {
		// 残高は beforeEach の遅延付与で当月(NEW)にリセット済み。そこへ「先月(OLD)に
		// 行われた予約」の consume 台帳を差し込み、月をまたいだ確定を再現する。
		const oldMonth = "2000-01";
		const requestId = `settle-monthboundary-${userId}`;
		await db.insert(creditLedger).values({
			id: `consume-${requestId}`,
			userId,
			amount: -30,
			type: "consume",
			requestId,
			periodMonth: oldMonth,
			tokenAmount: 30_000,
		});

		await settleReservation(userId, requestId, 30, 10_000);

		// 残高は据え置き(リセット後残高への差分混入・超過を防ぐ)。台帳の :settle は記録される。
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:settle`)).toHaveLength(1);
	});
});

describe("refundReservation のガード (#144/#146)", () => {
	let userId: string;
	beforeEach(async () => {
		userId = await freshUser();
		await ensureCurrentMonthGranted(userId);
	});

	it("settle 済みの予約は返却をスキップする(消費のネットプラス防止・#144)", async () => {
		const requestId = `refund-settled-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await settleReservation(userId, requestId, 30, 10_000); // +20 → 40

		// settle 後に返却が呼ばれても全額返却しない。
		await refundReservation(userId, requestId, 30);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE - 30 + 20);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(0);
	});

	it("通常の返却は反映し、二重返却で二重加算しない(#146)", async () => {
		const requestId = `refund-${userId}`;
		await reserveCredits(userId, 30_000, requestId); // 50→20
		await refundReservation(userId, requestId, 30); // +30 → 50
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);

		await refundReservation(userId, requestId, 30);
		expect(await readBalance(userId)).toBe(MONTHLY_CREDITS_FREE);
		expect(await ledgerByRequestId(`${requestId}:refund`)).toHaveLength(1);
	});
});
