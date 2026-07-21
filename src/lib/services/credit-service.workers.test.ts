import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import { creditLedger } from "#/db/schema";
import {
	MONTHLY_CREDITS_FREE,
	MONTHLY_CREDITS_PREMIUM,
} from "#/lib/billing/plans";
import { currentMonthKey } from "#/lib/credit/month";
import {
	ensureCurrentMonthGranted,
	getBalance,
	reserveCredits,
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
