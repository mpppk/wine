import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { formatDateTime } from "./format";

export function CouponCard({ detail }: { detail: AdminUserDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>クーポン利用履歴</CardTitle>
			</CardHeader>
			<CardContent>
				{detail.coupons.length === 0 ? (
					<p className="text-sm text-muted-foreground">利用履歴なし</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">コード</th>
									<th className="px-3 py-2 text-right font-medium">延長日数</th>
									<th className="px-3 py-2 font-medium">適用日時</th>
								</tr>
							</thead>
							<tbody>
								{detail.coupons.map((c) => (
									<tr
										key={c.id}
										className="border-b border-border last:border-b-0"
									>
										<td className="px-3 py-2">
											{c.code.startsWith("admin:") ? (
												<span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
													管理者発行
												</span>
											) : (
												<code className="text-xs">{c.code}</code>
											)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums">
											{c.extendedDays}日
										</td>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{formatDateTime(c.redeemedAt)}
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
