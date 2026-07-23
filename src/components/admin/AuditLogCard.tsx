import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { adminAuditActionLabel } from "#/lib/admin/audit";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { formatDateTime } from "./format";

/** 監査ログの detail(action 固有JSON)を人間可読な短い文字列に整形する。 */
function formatAuditDetail(
	action: string,
	detail: AdminUserDetail["auditLogs"][number]["detail"],
): string {
	if (!detail) return "-";
	if (action === "credit_grant" && typeof detail.amount === "number") {
		return `+${detail.amount.toLocaleString("ja-JP")} クレジット`;
	}
	if (action === "premium_extension" && typeof detail.days === "number") {
		return `${detail.days}日延長`;
	}
	if (action === "ban") {
		return typeof detail.banExpiresInDays === "number"
			? `${detail.banExpiresInDays}日間`
			: "無期限";
	}
	if (action === "revoke_mcp") {
		return `トークン${detail.tokensDeleted ?? 0}件 / 同意${detail.consentsDeleted ?? 0}件 削除`;
	}
	return JSON.stringify(detail);
}

export function AuditLogCard({ detail }: { detail: AdminUserDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>管理操作履歴</CardTitle>
			</CardHeader>
			<CardContent>
				{detail.auditLogs.length === 0 ? (
					<p className="text-sm text-muted-foreground">履歴なし</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">日時</th>
									<th className="px-3 py-2 font-medium">操作</th>
									<th className="px-3 py-2 font-medium">内容</th>
									<th className="px-3 py-2 font-medium">理由</th>
									<th className="px-3 py-2 font-medium">操作者</th>
								</tr>
							</thead>
							<tbody>
								{detail.auditLogs.map((log) => (
									<tr
										key={log.id}
										className="border-b border-border last:border-b-0"
									>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{formatDateTime(log.createdAt)}
										</td>
										<td className="whitespace-nowrap px-3 py-2">
											{adminAuditActionLabel(log.action)}
										</td>
										<td className="px-3 py-2">
											{formatAuditDetail(log.action, log.detail)}
										</td>
										<td className="px-3 py-2 break-all">{log.reason ?? "-"}</td>
										<td className="px-3 py-2 break-all text-muted-foreground">
											{log.actorName ?? log.actorEmail ?? "-"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
