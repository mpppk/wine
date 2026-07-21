import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { creditBalance, creditLedger } from "#/db/schema";
import { refundCredits, tokensToCredits } from "#/lib/credit/credit-math";
import { monthlyGrantForPlan } from "#/lib/credit/grants";
import { currentMonthKey } from "#/lib/credit/month";
import { logError, logInfo } from "#/lib/logger";
import * as billingService from "#/lib/services/billing-service";

// AIクレジットの付与・消費のD1アクセス層。判定・換算の純ロジックは #/lib/credit/ に置き、
// ここは台帳(credit_ledger)と残高キャッシュ(credit_balance)への薄い橋渡しに徹する。
//
// 付与は暦月一律だが Cron は導入せず「遅延付与」する: 残高参照・消費の入口で必ず
// ensureCurrentMonthGranted を呼び、当月未付与なら付与する(冪等)。将来 Cron を足す場合は
// この関数を per-user でループ呼び出しすれば proactive 付与に拡張できる。
//
// 消費はトークン従量で、消費量が事前に確定しないため「予約(reserve)→ 実測確定(settle)」で
// 扱う: 先に最大見積を条件付きで引き(残高不足ならブロック)、実測との差分を返却する。

export interface CreditBalance {
	balance: number;
	periodMonth: string;
}

export type ReserveResult =
	| {
			ok: true;
			requestId: string;
			/** 予約した(=残高から引いた)クレジット */
			reservedCredits: number;
			reservedTokens: number;
			balanceAfter: number;
	  }
	| {
			ok: false;
			reason: "insufficient";
			balance: number;
			required: number;
	  };

/**
 * 当月分が未付与なら遅延付与し、さらに月途中のプラン昇格分を差分付与する(冪等)。
 * 残高参照・消費の入口で必ず呼ぶ。
 * - 当月未付与(新月/残高行なし): 現プランの付与額でリセット付与する。
 *   grant 台帳は requestId=grant:{userId}:{YYYY-MM} の unique で月1本に絞り、
 *   残高は新月のみ付与額へリセット(setWhere で当月への二重リセットを防ぎ、消費との
 *   競合で残高を巻き戻さない)。
 * - 当月付与済みでも、現プランの付与額が当月の累計付与額を上回る場合(=月途中の
 *   プレミアム昇格)は差分を追加付与する(#142)。requestId=grant_upgrade:{userId}:{YYYY-MM}
 *   の unique で月1本に絞り、翌JST月初のリセット付与までブロックが継続しないようにする。
 */
export async function ensureCurrentMonthGranted(userId: string): Promise<void> {
	const month = currentMonthKey();
	const existing = await db
		.select({ periodMonth: creditBalance.periodMonth })
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);

	// 現プランでの当月付与目標額。昇格検知にも使うため高速パスの前に確定する。
	const isPremium = await billingService.isPremiumUser(userId);
	const target = monthlyGrantForPlan(isPremium);

	if (existing[0]?.periodMonth === month) {
		await topUpMidMonthUpgrade(userId, month, target);
		return;
	}

	const requestId = `grant:${userId}:${month}`;
	await db.batch([
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: target,
				type: "grant",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		db
			.insert(creditBalance)
			.values({ userId, balance: target, periodMonth: month })
			.onConflictDoUpdate({
				target: creditBalance.userId,
				set: { balance: target, periodMonth: month, updatedAt: new Date() },
				// 別リクエストが既に当月へリセット済みなら上書きしない(消費の巻き戻し防止)
				setWhere: sql`${creditBalance.periodMonth} <> ${month}`,
			}),
	]);
}

/**
 * 月途中のプラン昇格でクレジットが不足する問題(#142)への差分付与。当月が既に付与済み
 * (残高行が当月)であることを前提に呼ぶ。当月の累計付与額(grant + grant_upgrade)が
 * 現プランの付与目標に満たなければ、その差分を残高へ加算し grant_upgrade 台帳に記録する。
 *
 * 冪等性は grant_upgrade:{userId}:{month} の unique 制約で担保する。残高加算は「まだ台帳に
 * この requestId が無い時だけ」に条件付け(台帳 INSERT より前に評価)し、再実行しても二重
 * 加算しない(admin-actions.grantCredits と同じパターン)。無料↔プレミアムの2値なので
 * 昇格の差分付与は月1回で足りる。降格時は差分が0以下となり何もしない(返却はしない)。
 */
async function topUpMidMonthUpgrade(
	userId: string,
	month: string,
	target: number,
): Promise<void> {
	const grantedRows = await db
		.select({
			total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`,
		})
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.periodMonth, month),
				inArray(creditLedger.type, ["grant", "grant_upgrade"]),
			),
		);
	const alreadyGranted = grantedRows[0]?.total ?? 0;
	const diff = target - alreadyGranted;
	if (diff <= 0) return;

	const requestId = `grant_upgrade:${userId}:${month}`;
	await db.batch([
		db
			.update(creditBalance)
			.set({
				balance: sql`${creditBalance.balance} + ${diff}`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(creditBalance.userId, userId),
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
				),
			),
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: diff,
				type: "grant_upgrade",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
	]);
}

/** 遅延付与を挟んでから現在残高を返す。残高行が無ければ 0 とみなす。 */
export async function getBalance(userId: string): Promise<CreditBalance> {
	await ensureCurrentMonthGranted(userId);
	const rows = await db
		.select({
			balance: creditBalance.balance,
			periodMonth: creditBalance.periodMonth,
		})
		.from(creditBalance)
		.where(eq(creditBalance.userId, userId))
		.limit(1);
	return rows[0] ?? { balance: 0, periodMonth: currentMonthKey() };
}

/**
 * 予約: 最大見積分を consume として仮計上し、残高から引く。
 * - 同一 requestId の予約が既にあれば再計上しない(冪等)
 * - 残高が足りる時だけ引く条件付きUPDATE。空結果=残高不足でブロック(throw しない)
 */
export async function reserveCredits(
	userId: string,
	estimateTokens: number,
	requestId: string,
): Promise<ReserveResult> {
	await ensureCurrentMonthGranted(userId);
	const required = tokensToCredits(estimateTokens);

	const dup = await db
		.select({ amount: creditLedger.amount })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId))
		.limit(1);
	if (dup[0]) {
		const cur = await getBalance(userId);
		return {
			ok: true,
			requestId,
			reservedCredits: -dup[0].amount,
			reservedTokens: estimateTokens,
			balanceAfter: cur.balance,
		};
	}

	const debited = await db
		.update(creditBalance)
		.set({ balance: sql`${creditBalance.balance} - ${required}` })
		.where(
			and(
				eq(creditBalance.userId, userId),
				sql`${creditBalance.balance} >= ${required}`,
			),
		)
		.returning({ balance: creditBalance.balance });
	if (!debited[0]) {
		const cur = await getBalance(userId);
		return {
			ok: false,
			reason: "insufficient",
			balance: cur.balance,
			required,
		};
	}

	await db.insert(creditLedger).values({
		id: crypto.randomUUID(),
		userId,
		amount: -required,
		type: "consume",
		requestId,
		periodMonth: currentMonthKey(),
		tokenAmount: estimateTokens,
	});

	return {
		ok: true,
		requestId,
		reservedCredits: required,
		reservedTokens: estimateTokens,
		balanceAfter: debited[0].balance,
	};
}

/** 確定: 実測トークンで予約との差分を refund として戻す。差分が無ければ何もしない。 */
export async function settleReservation(
	userId: string,
	requestId: string,
	reservedCredits: number,
	actualTokens: number,
): Promise<void> {
	const back = refundCredits(reservedCredits, actualTokens);
	if (back <= 0) return;
	await db.batch([
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: back,
				type: "refund",
				requestId: `${requestId}:settle`,
				periodMonth: currentMonthKey(),
				tokenAmount: actualTokens,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		db
			.update(creditBalance)
			.set({ balance: sql`${creditBalance.balance} + ${back}` })
			.where(eq(creditBalance.userId, userId)),
	]);
}

/**
 * 失敗補償: 予約を返却し、その成否を requestId 付きで記録する。返却自体が D1 障害で
 * 失敗しても throw せずログに留め、呼び出し側が本来の失敗例外を伝播できるようにする。
 * これが無いと、AI失敗+返却失敗が重なった際に元の失敗例外が握り潰され、クレジット消失が
 * 無記録になる(#158)。台帳(credit_ledger)との突合用に返却成功も logInfo で残す。
 */
export async function refundReservationOnFailure(
	userId: string,
	requestId: string,
	reservedCredits: number,
): Promise<void> {
	try {
		await refundReservation(userId, requestId, reservedCredits);
		if (reservedCredits > 0) {
			logInfo("inference failed; reservation refunded", {
				userId,
				requestId,
				reservedCredits,
			});
		}
	} catch (refundErr) {
		logError("credit refund failed after inference error", {
			userId,
			requestId,
			reservedCredits,
			err: refundErr,
		});
	}
}

/** 失敗時: 予約全額を refund として戻す。 */
export async function refundReservation(
	userId: string,
	requestId: string,
	reservedCredits: number,
): Promise<void> {
	if (reservedCredits <= 0) return;
	await db.batch([
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: reservedCredits,
				type: "refund",
				requestId: `${requestId}:refund`,
				periodMonth: currentMonthKey(),
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		db
			.update(creditBalance)
			.set({ balance: sql`${creditBalance.balance} + ${reservedCredits}` })
			.where(eq(creditBalance.userId, userId)),
	]);
}
