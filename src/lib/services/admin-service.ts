import { count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { subscription, user } from "#/db/auth-schema";
import {
	type AdminAuditDetail,
	adminAuditLog,
	couponRedemption,
	creditBalance,
	creditLedger,
} from "#/db/schema";
import {
	ADMIN_USERS_PAGE_SIZE,
	clampPage,
	likeContains,
} from "#/lib/admin/search";
import { type PlanId, resolvePlan } from "#/lib/billing/entitlements";

// 管理画面(ユーザ管理)のサービス層。閲覧専用のクエリのみを持つ。
// 注意: creditService.getBalance は当月分を遅延付与する副作用があるため、
// ここでは credit_balance / credit_ledger を生 SELECT する(閲覧が付与を起こさない)。

export interface AdminUserListItem {
	id: string;
	name: string;
	email: string;
	image: string | null;
	createdAt: Date;
	role: string | null;
	banned: boolean | null;
	plan: PlanId;
	/** クレジット残高。null は credit_balance 行なし(未付与)。 */
	creditBalance: number | null;
}

export interface AdminUserListResult {
	users: AdminUserListItem[];
	total: number;
	page: number;
	pageSize: number;
}

/** ユーザ一覧を email/name の部分一致で検索し、登録日降順でページングして返す。 */
export async function listUsers(input: {
	q?: string;
	page: number;
}): Promise<AdminUserListResult> {
	const q = input.q?.trim();
	const where = q
		? or(
				sql`${user.email} LIKE ${likeContains(q)} ESCAPE '\\'`,
				sql`${user.name} LIKE ${likeContains(q)} ESCAPE '\\'`,
			)
		: undefined;

	const totalRows = await db.select({ total: count() }).from(user).where(where);
	const total = totalRows[0]?.total ?? 0;
	const page = clampPage(input.page, total, ADMIN_USERS_PAGE_SIZE);

	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			createdAt: user.createdAt,
			role: user.role,
			banned: user.banned,
		})
		.from(user)
		.where(where)
		.orderBy(desc(user.createdAt))
		.limit(ADMIN_USERS_PAGE_SIZE)
		.offset((page - 1) * ADMIN_USERS_PAGE_SIZE);

	const ids = rows.map((r) => r.id);
	const [subRows, balanceRows] =
		ids.length > 0
			? await Promise.all([
					db
						.select({
							referenceId: subscription.referenceId,
							status: subscription.status,
							periodEnd: subscription.periodEnd,
						})
						.from(subscription)
						.where(inArray(subscription.referenceId, ids)),
					db
						.select({
							userId: creditBalance.userId,
							balance: creditBalance.balance,
						})
						.from(creditBalance)
						.where(inArray(creditBalance.userId, ids)),
				])
			: [[], []];

	const subsByUser = new Map<
		string,
		{ status: string | null; periodEnd: Date | null }[]
	>();
	for (const s of subRows) {
		const list = subsByUser.get(s.referenceId) ?? [];
		list.push({ status: s.status, periodEnd: s.periodEnd });
		subsByUser.set(s.referenceId, list);
	}
	const balanceByUser = new Map(balanceRows.map((b) => [b.userId, b.balance]));

	return {
		users: rows.map((r) => ({
			...r,
			plan: resolvePlan(subsByUser.get(r.id) ?? []),
			creditBalance: balanceByUser.get(r.id) ?? null,
		})),
		total,
		page,
		pageSize: ADMIN_USERS_PAGE_SIZE,
	};
}

export interface AdminUserDetail {
	user: {
		id: string;
		name: string;
		email: string;
		emailVerified: boolean;
		image: string | null;
		stripeCustomerId: string | null;
		preferredAiModel: string | null;
		role: string | null;
		banned: boolean | null;
		banReason: string | null;
		banExpires: Date | null;
		createdAt: Date;
		updatedAt: Date;
	};
	/** 全サブスクリプション行から解決した現在のプラン。 */
	plan: PlanId;
	subscriptions: Array<{
		id: string;
		plan: string;
		status: string | null;
		periodStart: Date | null;
		periodEnd: Date | null;
		trialStart: Date | null;
		trialEnd: Date | null;
		cancelAtPeriodEnd: boolean | null;
		canceledAt: Date | null;
		endedAt: Date | null;
		billingInterval: string | null;
	}>;
	/** クレジット残高。null は credit_balance 行なし(未付与)。 */
	credit: { balance: number; periodMonth: string; updatedAt: Date } | null;
	/** クレジット台帳の最新50件(新しい順)。 */
	ledger: Array<{
		id: string;
		amount: number;
		type: string;
		periodMonth: string;
		tokenAmount: number | null;
		createdAt: Date;
	}>;
	/** クーポン適用履歴(新しい順)。 */
	coupons: Array<{
		id: string;
		code: string;
		extendedDays: number;
		redeemedAt: Date;
	}>;
	/** このユーザに対する管理操作の監査ログ(新しい順)。 */
	auditLogs: Array<{
		id: string;
		action: string;
		reason: string | null;
		detail: AdminAuditDetail | null;
		createdAt: Date;
		/** 操作した管理者の表示名/メール(削除済みなら null)。 */
		actorName: string | null;
		actorEmail: string | null;
	}>;
}

const LEDGER_LIMIT = 50;
const AUDIT_LOG_LIMIT = 50;

/** ユーザ詳細(基本情報・サブスク・クレジット・クーポン履歴)を集約して返す。 */
export async function getUserDetail(
	userId: string,
): Promise<AdminUserDetail | null> {
	const [userRow] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: user.emailVerified,
			image: user.image,
			stripeCustomerId: user.stripeCustomerId,
			preferredAiModel: user.preferredAiModel,
			role: user.role,
			banned: user.banned,
			banReason: user.banReason,
			banExpires: user.banExpires,
			createdAt: user.createdAt,
			updatedAt: user.updatedAt,
		})
		.from(user)
		.where(eq(user.id, userId));
	if (!userRow) return null;

	const [subscriptions, balanceRows, ledger, coupons, auditLogs] =
		await Promise.all([
			db
				.select({
					id: subscription.id,
					plan: subscription.plan,
					status: subscription.status,
					periodStart: subscription.periodStart,
					periodEnd: subscription.periodEnd,
					trialStart: subscription.trialStart,
					trialEnd: subscription.trialEnd,
					cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
					canceledAt: subscription.canceledAt,
					endedAt: subscription.endedAt,
					billingInterval: subscription.billingInterval,
				})
				.from(subscription)
				.where(eq(subscription.referenceId, userId)),
			db
				.select({
					balance: creditBalance.balance,
					periodMonth: creditBalance.periodMonth,
					updatedAt: creditBalance.updatedAt,
				})
				.from(creditBalance)
				.where(eq(creditBalance.userId, userId)),
			db
				.select({
					id: creditLedger.id,
					amount: creditLedger.amount,
					type: creditLedger.type,
					periodMonth: creditLedger.periodMonth,
					tokenAmount: creditLedger.tokenAmount,
					createdAt: creditLedger.createdAt,
				})
				.from(creditLedger)
				.where(eq(creditLedger.userId, userId))
				.orderBy(desc(creditLedger.createdAt))
				.limit(LEDGER_LIMIT),
			db
				.select({
					id: couponRedemption.id,
					code: couponRedemption.code,
					extendedDays: couponRedemption.extendedDays,
					redeemedAt: couponRedemption.redeemedAt,
				})
				.from(couponRedemption)
				.where(eq(couponRedemption.userId, userId))
				.orderBy(desc(couponRedemption.redeemedAt)),
			// 監査ログは actorUserId(=操作した管理者)を user に left join して表示名を引く。
			// actorUserId は FK 無しの文字列参照なので、削除済み管理者では actor* が null になる。
			db
				.select({
					id: adminAuditLog.id,
					action: adminAuditLog.action,
					reason: adminAuditLog.reason,
					detail: adminAuditLog.detail,
					createdAt: adminAuditLog.createdAt,
					actorName: user.name,
					actorEmail: user.email,
				})
				.from(adminAuditLog)
				.leftJoin(user, eq(adminAuditLog.actorUserId, user.id))
				.where(eq(adminAuditLog.targetUserId, userId))
				.orderBy(desc(adminAuditLog.createdAt))
				.limit(AUDIT_LOG_LIMIT),
		]);

	return {
		user: userRow,
		plan: resolvePlan(subscriptions),
		subscriptions,
		credit: balanceRows[0] ?? null,
		ledger,
		coupons,
		auditLogs,
	};
}
