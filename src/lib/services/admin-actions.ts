import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { adminAuditLog, creditBalance, creditLedger } from "#/db/schema";
import { currentMonthKey } from "#/lib/credit/month";
import { ensureCurrentMonthGranted } from "#/lib/services/credit-service";

// 管理画面の「書き込み(副作用あり)」操作のサービス層。閲覧専用の admin-service とは
// 分離し、各操作は admin_audit_log に証跡を残す。

export interface GrantCreditsResult {
	/** 付与後の残高。 */
	balanceAfter: number;
	/** 残高が属する付与月 "YYYY-MM"(JST)。 */
	periodMonth: string;
	/** 今回付与しようとしたクレジット数。 */
	grantedAmount: number;
	/** 同一 requestId で既に付与済み(冪等再送)なら true。残高は加算されない。 */
	alreadyApplied: boolean;
}

async function readBalance(
	userId: string,
): Promise<{ balance: number; periodMonth: string }> {
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
 * 管理者がユーザへクレジットを手動付与する(#113 障害補填・お詫び)。
 *
 * 案A(当月末まで有効): 当月残高に加算し、翌月の月次付与で補填分はリセット(失効)される。
 * そのため付与前に ensureCurrentMonthGranted で当月の残高行を確定させ、加算基準を当月に揃える。
 *
 * 冪等性は credit_ledger.request_id の unique 制約で担保する。残高加算・台帳追記・監査ログを
 * 単一の db.batch で原子的に書き、残高加算は「まだ台帳に requestId が無い時だけ」に条件付け
 * (台帳 INSERT より前に評価)することで、万一の再実行でも二重加算しない。
 */
export async function grantCredits(params: {
	actorUserId: string;
	targetUserId: string;
	amount: number;
	reason: string;
	/** 冪等キー。未指定ならサーバで生成する。 */
	requestId?: string;
}): Promise<GrantCreditsResult> {
	const { actorUserId, targetUserId, amount, reason } = params;
	const requestId = params.requestId ?? `admin_grant:${crypto.randomUUID()}`;

	// 当月の残高行を確定(案A: 加算の基準を当月付与額に揃える)。
	await ensureCurrentMonthGranted(targetUserId);
	const month = currentMonthKey();

	// 既に同一 requestId で付与済みなら、加算・監査追記をせず現在残高を返す(冪等)。
	const existing = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(eq(creditLedger.requestId, requestId))
		.limit(1);
	if (existing[0]) {
		const bal = await readBalance(targetUserId);
		return {
			balanceAfter: bal.balance,
			periodMonth: bal.periodMonth,
			grantedAmount: amount,
			alreadyApplied: true,
		};
	}

	await db.batch([
		// 残高加算。まだ台帳に requestId が無い時だけ加算する(台帳 INSERT より前に評価される
		// ため、再実行時は既存行を見て加算をスキップし二重加算を防ぐ)。
		db
			.update(creditBalance)
			.set({
				balance: sql`${creditBalance.balance} + ${amount}`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(creditBalance.userId, targetUserId),
					sql`NOT EXISTS (SELECT 1 FROM credit_ledger WHERE request_id = ${requestId})`,
				),
			),
		// 台帳追記。type="admin_grant" で月次付与と区別する。unique(request_id) が再送を弾く。
		db
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId: targetUserId,
				amount,
				type: "admin_grant",
				requestId,
				periodMonth: month,
				tokenAmount: null,
			})
			.onConflictDoNothing({ target: creditLedger.requestId }),
		// 監査ログ。
		db.insert(adminAuditLog).values({
			id: crypto.randomUUID(),
			actorUserId,
			targetUserId,
			action: "credit_grant",
			detail: { amount, requestId, periodMonth: month },
			reason,
		}),
	]);

	const bal = await readBalance(targetUserId);
	return {
		balanceAfter: bal.balance,
		periodMonth: bal.periodMonth,
		grantedAmount: amount,
		alreadyApplied: false,
	};
}
