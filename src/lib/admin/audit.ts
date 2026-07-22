// admin_audit_log.action の唯一の情報源(SSOT)。監査ログの操作種別IDと日本語ラベルを
// ここで一元管理する(QUIZ_TYPES と同じ as-const パターン)。schema.ts の action カラムの
// .$type()、recordAudit 等の書き込み側、UIのラベル表(admin.$userId.tsx)はすべて
// この union/レコードから導出し、新しい action の追加漏れをコンパイラが検出できるようにする。
export const ADMIN_AUDIT_ACTIONS = [
	{ id: "credit_grant", labelJa: "クレジット付与" },
	{ id: "premium_extension", labelJa: "プレミアム期間延長" },
	{ id: "bulk_credit_grant", labelJa: "一括クレジット付与" },
	{ id: "revoke_sessions", labelJa: "全セッション失効" },
	{ id: "ban", labelJa: "利用停止(BAN)" },
	{ id: "unban", labelJa: "停止解除" },
	{ id: "revoke_mcp", labelJa: "MCP連携失効" },
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number]["id"];

/** 操作種別 → 日本語ラベル。UI表示はこのレコードから引く(全 action の網羅を型が保証する)。 */
export const ADMIN_AUDIT_ACTION_LABELS_JA: Record<AdminAuditAction, string> =
	Object.fromEntries(
		ADMIN_AUDIT_ACTIONS.map((a) => [a.id, a.labelJa]),
	) as Record<AdminAuditAction, string>;

/**
 * 監査ログ action の日本語ラベルを引く。server fn 境界で型が string に広がった値も
 * 受けられるよう string を受け、未知の action はそのまま返す。
 */
export function adminAuditActionLabel(action: string): string {
	return ADMIN_AUDIT_ACTION_LABELS_JA[action as AdminAuditAction] ?? action;
}
