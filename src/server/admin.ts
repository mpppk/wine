import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	ADMIN_CREDIT_GRANT_MAX,
	ADMIN_CREDIT_GRANT_MIN,
	ADMIN_GRANT_REASON_MAX,
} from "#/lib/admin/credit-grant";
import {
	BAN_EXPIRES_MAX_DAYS,
	BAN_EXPIRES_MIN_DAYS,
} from "#/lib/admin/moderation";
import {
	ADMIN_EXTENSION_MAX_DAYS,
	ADMIN_EXTENSION_MIN_DAYS,
} from "#/lib/admin/premium-extension";
import { auth } from "#/lib/auth";
import * as adminActions from "#/lib/services/admin-actions";
import * as adminService from "#/lib/services/admin-service";
import { adminMiddleware } from "./middleware";

const DAY_SECONDS = 24 * 60 * 60;

// 管理画面(ユーザ管理)のRPC。すべて adminMiddleware で role="admin" のみに制限する。

/** ユーザ一覧を検索・ページングして返す。管理者限定。 */
export const adminListUsers = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			q: z.string().trim().max(200).optional(),
			page: z.number().int().min(1).max(10_000).default(1),
		}),
	)
	.handler(({ data }) => adminService.listUsers(data));

/** ユーザ詳細(基本情報・サブスク・クレジット・クーポン履歴)を返す。管理者限定。 */
export const adminGetUserDetail = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.inputValidator(z.object({ userId: z.string().min(1).max(100) }))
	.handler(({ data }) => adminService.getUserDetail(data.userId));

/**
 * ユーザへクレジットを手動付与する(#113 障害補填・お詫び)。理由必須。管理者限定。
 * context.user(=操作した管理者)を監査ログの actor として記録する。
 */
export const adminGrantCredits = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			amount: z
				.number()
				.int()
				.min(ADMIN_CREDIT_GRANT_MIN)
				.max(ADMIN_CREDIT_GRANT_MAX),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
			/** クライアント発行の冪等キー(再送の二重付与防止)。 */
			requestId: z.string().min(1).max(200).optional(),
		}),
	)
	.handler(({ data, context }) =>
		adminActions.grantCredits({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			amount: data.amount,
			reason: data.reason,
			requestId: data.requestId,
		}),
	);

/**
 * プレミアム会員の期間を直接延長する(#114 お詫び, 案b)。理由必須。管理者限定。
 * プレミアム会員でなければサービス層が throw する。
 */
export const adminExtendPremium = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			days: z
				.number()
				.int()
				.min(ADMIN_EXTENSION_MIN_DAYS)
				.max(ADMIN_EXTENSION_MAX_DAYS),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
		}),
	)
	.handler(({ data, context }) =>
		adminActions.extendPremium({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			days: data.days,
			reason: data.reason,
		}),
	);

// ── #115: セッション/MCP失効・BAN ──────────────────────────────────────────────
// better-auth admin プラグインのサーバAPIを、呼び出し元(admin)のリクエストヘッダ付きで
// 呼ぶ(プラグイン側の admin 認可を通すためヘッダが必要)。全操作を監査ログに記録する。

/** 全セッションを強制ログアウトする(#115)。理由必須。管理者限定。 */
export const adminRevokeSessions = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
		}),
	)
	.handler(async ({ data, context }) => {
		await auth.api.revokeUserSessions({
			body: { userId: data.userId },
			headers: getRequest().headers,
		});
		await adminActions.recordAudit({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			action: "revoke_sessions",
			reason: data.reason,
		});
		return { ok: true as const };
	});

/** ユーザを BAN(利用停止)する(#115)。理由必須、期限は任意(未指定は無期限)。管理者限定。 */
export const adminBanUser = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
			expiresInDays: z
				.number()
				.int()
				.min(BAN_EXPIRES_MIN_DAYS)
				.max(BAN_EXPIRES_MAX_DAYS)
				.optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		// 自分自身の BAN はロックアウトになるため拒否する。
		if (data.userId === context.user.id) {
			throw new Error("自分自身を利用停止することはできません。");
		}
		await auth.api.banUser({
			body: {
				userId: data.userId,
				banReason: data.reason,
				banExpiresIn: data.expiresInDays
					? data.expiresInDays * DAY_SECONDS
					: undefined,
			},
			headers: getRequest().headers,
		});
		await adminActions.recordAudit({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			action: "ban",
			reason: data.reason,
			detail: { banExpiresInDays: data.expiresInDays ?? null },
		});
		return { ok: true as const };
	});

/** ユーザの BAN を解除する(#115)。理由必須。管理者限定。 */
export const adminUnbanUser = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
		}),
	)
	.handler(async ({ data, context }) => {
		await auth.api.unbanUser({
			body: { userId: data.userId },
			headers: getRequest().headers,
		});
		await adminActions.recordAudit({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			action: "unban",
			reason: data.reason,
		});
		return { ok: true as const };
	});

/** ユーザの MCP(OAuth)連携をすべて失効する(#115)。理由必須。管理者限定。 */
export const adminRevokeMcp = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.inputValidator(
		z.object({
			userId: z.string().min(1).max(100),
			reason: z.string().trim().min(1).max(ADMIN_GRANT_REASON_MAX),
		}),
	)
	.handler(async ({ data, context }) => {
		const res = await adminActions.revokeMcpConnections(data.userId);
		await adminActions.recordAudit({
			actorUserId: context.user.id,
			targetUserId: data.userId,
			action: "revoke_mcp",
			reason: data.reason,
			detail: {
				tokensDeleted: res.tokensDeleted,
				consentsDeleted: res.consentsDeleted,
			},
		});
		return res;
	});
