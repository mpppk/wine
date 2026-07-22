import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { oauthAccessToken, oauthConsent } from "#/db/auth-schema";
import {
	type AdminAuditDetail,
	adminAuditLog,
	couponRedemption,
	creditBalance,
	creditLedger,
} from "#/db/schema";
import type { AdminAuditAction } from "#/lib/admin/audit";
import { currentMonthKey } from "#/lib/credit/month";
import * as billingService from "#/lib/services/billing-service";
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

export interface ExtendPremiumResult {
	extendedDays: number;
	/** 延長後の次回請求日(ミリ秒)。webhook 反映前でも表示できるよう返す。 */
	newPeriodEnd: number;
}

/**
 * 管理者がプレミアム会員の期間を直接延長する(#114 お詫び, 案b)。
 * Stripe trial_end 延長ロジック(billingService.extendPremiumTrial)を流用し、コード入力を
 * 挟まず即時反映する。期間延長は**プレミアム会員のみ**有効(無料ユーザへのお詫びは #113 の
 * クレジット補填が受け皿)。適用履歴を coupon_redemption と admin_audit_log の両方に記録する。
 *
 * 注: 「N日延長」は自然な冪等キーを持たない(再送すると二重に延長される)ため、UI 側の確認
 * ダイアログと送信中ボタン無効化で二重送信を防ぐ(クレジット付与と異なり冪等ではない)。
 */
export async function extendPremium(params: {
	actorUserId: string;
	targetUserId: string;
	days: number;
	reason: string;
}): Promise<ExtendPremiumResult> {
	const { actorUserId, targetUserId, days, reason } = params;

	// Stripe 側を先に延長する(プレミアムでなければ throw)。DBの periodEnd は webhook で同期。
	const { newPeriodEnd, stripeSubscriptionId } =
		await billingService.extendPremiumTrial(targetUserId, days);

	// 適用履歴を coupon_redemption(管理者発行の合成コード)と監査ログに記録する。
	// コードは unique(userId, code) を満たすよう毎回一意にする(接頭辞 "admin:" で判別)。
	const code = `admin:${crypto.randomUUID()}`;
	await db.batch([
		db.insert(couponRedemption).values({
			id: crypto.randomUUID(),
			userId: targetUserId,
			code,
			extendedDays: days,
		}),
		db.insert(adminAuditLog).values({
			id: crypto.randomUUID(),
			actorUserId,
			targetUserId,
			action: "premium_extension",
			detail: { days, newPeriodEnd, stripeSubscriptionId, code },
			reason,
		}),
	]);

	return { extendedDays: days, newPeriodEnd };
}

/**
 * 管理操作の証跡を admin_audit_log に1行記録する。破壊的操作の共通後処理。
 * targetUserId は特定ユーザに紐づかない操作(一括付与など)では null を渡す。
 */
export async function recordAudit(params: {
	actorUserId: string;
	targetUserId: string | null;
	action: AdminAuditAction;
	reason: string;
	detail?: AdminAuditDetail | null;
}): Promise<void> {
	await db.insert(adminAuditLog).values({
		id: crypto.randomUUID(),
		actorUserId: params.actorUserId,
		targetUserId: params.targetUserId,
		action: params.action,
		detail: params.detail ?? null,
		reason: params.reason,
	});
}

/**
 * ユーザの MCP(OAuth)連携をすべて失効する(#115)。アカウント乗っ取り疑い・連携アプリ側の
 * 事故に対応する。oauth_access_token / oauth_consent の該当ユーザ行を削除する。
 * better-auth の mcp プラグインには失効APIが無いため直接削除する。
 */
export async function revokeMcpConnections(
	userId: string,
): Promise<{ tokensDeleted: number; consentsDeleted: number }> {
	const [tokens, consents] = await db.batch([
		db
			.delete(oauthAccessToken)
			.where(eq(oauthAccessToken.userId, userId))
			.returning({ id: oauthAccessToken.id }),
		db
			.delete(oauthConsent)
			.where(eq(oauthConsent.userId, userId))
			.returning({ id: oauthConsent.id }),
	]);
	return { tokensDeleted: tokens.length, consentsDeleted: consents.length };
}

export interface BulkGrantResult {
	/** 対象ユーザ数。 */
	affected: number;
	/** 新規に付与したユーザ数。 */
	granted: number;
	/** 既に同一インシデントで付与済み(冪等スキップ)だったユーザ数。 */
	alreadyApplied: number;
	/** 今回新規付与した合計クレジット(granted × amount)。 */
	totalGranted: number;
}

/**
 * 障害補填などで複数ユーザへ一括でクレジットを付与する(#116)。各ユーザへの付与は #113 の
 * grantCredits を流用し、requestId=`admin_grant:{incidentId}:{userId}` で冪等化する
 * (同一インシデントの再実行では二重付与しない)。各ユーザに credit_grant の監査ログが残り、
 * さらに一括操作全体の要約を bulk_credit_grant(targetUserId=null)として1行記録する。
 */
export async function bulkGrantCredits(params: {
	actorUserId: string;
	incidentId: string;
	userIds: string[];
	amount: number;
	reason: string;
}): Promise<BulkGrantResult> {
	let granted = 0;
	let alreadyApplied = 0;
	for (const userId of params.userIds) {
		const res = await grantCredits({
			actorUserId: params.actorUserId,
			targetUserId: userId,
			amount: params.amount,
			reason: params.reason,
			requestId: `admin_grant:${params.incidentId}:${userId}`,
		});
		if (res.alreadyApplied) alreadyApplied += 1;
		else granted += 1;
	}
	await recordAudit({
		actorUserId: params.actorUserId,
		targetUserId: null,
		action: "bulk_credit_grant",
		reason: params.reason,
		detail: {
			incidentId: params.incidentId,
			affected: params.userIds.length,
			granted,
			alreadyApplied,
			amount: params.amount,
		},
	});
	return {
		affected: params.userIds.length,
		granted,
		alreadyApplied,
		totalGranted: granted * params.amount,
	};
}
