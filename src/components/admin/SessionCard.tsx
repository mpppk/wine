import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminRevokeSessions } from "#/server/admin";
import { DangerAction } from "./DangerAction";
import { formatDateTime } from "./format";

export function SessionCard({
	detail,
	isSelf,
}: {
	detail: AdminUserDetail;
	isSelf: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>アクティブセッション</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{detail.sessions.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						有効なセッションはありません。
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">IPアドレス</th>
									<th className="px-3 py-2 font-medium">User-Agent</th>
									<th className="px-3 py-2 font-medium">作成</th>
									<th className="px-3 py-2 font-medium">有効期限</th>
								</tr>
							</thead>
							<tbody>
								{detail.sessions.map((s) => (
									<tr
										key={s.id}
										className="border-b border-border last:border-b-0"
									>
										<td className="whitespace-nowrap px-3 py-2">
											{s.ipAddress || "-"}
											{s.impersonatedBy && (
												<span className="ml-1 rounded-full border border-border px-1.5 text-xs text-muted-foreground">
													なりすまし
												</span>
											)}
										</td>
										<td className="max-w-xs truncate px-3 py-2 text-muted-foreground">
											{s.userAgent || "-"}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{formatDateTime(s.createdAt)}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{formatDateTime(s.expiresAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<DangerAction
					label="全セッションを強制ログアウト"
					confirmTitle="全セッション強制ログアウトの確認"
					confirmBody={`${detail.user.name} の全セッションを失効します(再ログインが必要になります)。`}
					doneMessage="全セッションを失効しました。"
					disabled={isSelf || detail.sessions.length === 0}
					disabledNote={isSelf ? "自分自身には実行できません。" : undefined}
					mutationFn={(r) =>
						adminRevokeSessions({ data: { userId: detail.user.id, reason: r } })
					}
				/>
			</CardContent>
		</Card>
	);
}
