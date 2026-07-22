import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminRevokeMcp } from "#/server/admin";
import { DangerAction } from "./DangerAction";
import { formatDate } from "./format";

export function McpCard({ detail }: { detail: AdminUserDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>MCP連携(OAuth)</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{detail.mcpConnections.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						MCP連携アプリはありません。
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">アプリ</th>
									<th className="px-3 py-2 font-medium">スコープ</th>
									<th className="px-3 py-2 font-medium">有効トークン</th>
									<th className="px-3 py-2 font-medium">同意</th>
								</tr>
							</thead>
							<tbody>
								{detail.mcpConnections.map((c) => (
									<tr
										key={c.clientId}
										className="border-b border-border last:border-b-0"
									>
										<td className="px-3 py-2">
											{c.appName ?? (
												<code className="text-xs">{c.clientId}</code>
											)}
										</td>
										<td className="max-w-xs truncate px-3 py-2 text-muted-foreground">
											{c.scopes || "-"}
										</td>
										<td className="whitespace-nowrap px-3 py-2 tabular-nums">
											{c.activeTokenCount > 0
												? `${c.activeTokenCount}件（〜${c.latestTokenExpiresAt ? formatDate(c.latestTokenExpiresAt) : "-"}）`
												: "なし"}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{c.consentGiven === null
												? "-"
												: c.consentGiven
													? "同意済み"
													: "未同意"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<DangerAction
					label="全MCP連携を失効"
					confirmTitle="MCP連携失効の確認"
					confirmBody={`${detail.user.name} の全MCPトークン・同意を削除します(連携アプリは再認可が必要になります)。`}
					doneMessage="MCP連携を失効しました。"
					disabled={detail.mcpConnections.length === 0}
					mutationFn={(r) =>
						adminRevokeMcp({ data: { userId: detail.user.id, reason: r } })
					}
				/>
			</CardContent>
		</Card>
	);
}
