import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { subscriptionStatusLabel } from "#/lib/admin/labels";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { formatDate } from "./format";

export function PlanCard({ detail }: { detail: AdminUserDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					プラン
					{detail.plan === "premium" ? (
						<span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
							プレミアム
						</span>
					) : (
						<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
							無料
						</span>
					)}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{detail.subscriptions.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						サブスクリプション履歴なし(無料プラン)
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">プラン</th>
									<th className="px-3 py-2 font-medium">ステータス</th>
									<th className="px-3 py-2 font-medium">請求間隔</th>
									<th className="px-3 py-2 font-medium">期間</th>
									<th className="px-3 py-2 font-medium">トライアル</th>
									<th className="px-3 py-2 font-medium">解約</th>
								</tr>
							</thead>
							<tbody>
								{detail.subscriptions.map((s) => (
									<tr
										key={s.id}
										className="border-b border-border last:border-b-0"
									>
										<td className="px-3 py-2">{s.plan}</td>
										<td className="whitespace-nowrap px-3 py-2">
											{subscriptionStatusLabel(s.status)}
										</td>
										<td className="px-3 py-2">
											{s.billingInterval === "year"
												? "年額"
												: s.billingInterval === "month"
													? "月額"
													: "-"}
										</td>
										<td className="whitespace-nowrap px-3 py-2">
											{formatDate(s.periodStart)} 〜 {formatDate(s.periodEnd)}
										</td>
										<td className="whitespace-nowrap px-3 py-2">
											{s.trialStart
												? `${formatDate(s.trialStart)} 〜 ${formatDate(s.trialEnd)}`
												: "-"}
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{s.cancelAtPeriodEnd
												? "期間終了で解約予定"
												: s.canceledAt
													? `解約: ${formatDate(s.canceledAt)}`
													: "-"}
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
