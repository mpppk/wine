import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { creditLedgerTypeLabel } from "#/lib/credit/types";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { formatDateTime } from "./format";

/**
 * µUSD を読みやすい USD 表記にする。桁が4桁またぐ($0.0002 〜 $0.30)ので、
 * 小さい値が 0 に丸められないよう有効数字で出す。
 */
function formatMicroUsd(microUsd: number): string {
	if (microUsd === 0) return "$0";
	const usd = microUsd / 1_000_000;
	return `$${usd < 0.01 ? usd.toFixed(5) : usd.toFixed(3)}`;
}

export function CreditCard({ detail }: { detail: AdminUserDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>クレジット</CardTitle>
			</CardHeader>
			<CardContent>
				{detail.credit ? (
					<p className="mb-4 text-sm">
						残高:{" "}
						<span className="text-lg font-bold tabular-nums">
							{detail.credit.balance.toLocaleString("ja-JP")}
						</span>{" "}
						<span className="text-muted-foreground">
							({detail.credit.periodMonth} 分 / 更新:{" "}
							{formatDateTime(detail.credit.updatedAt)})
						</span>
					</p>
				) : (
					<p className="mb-4 text-sm text-muted-foreground">
						未付与(クレジットをまだ利用していません)
					</p>
				)}
				{detail.ledger.length > 0 && (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">日時</th>
									<th className="px-3 py-2 font-medium">種別</th>
									<th className="px-3 py-2 text-right font-medium">増減</th>
									<th className="px-3 py-2 text-right font-medium">原価</th>
									<th className="px-3 py-2 text-right font-medium">トークン</th>
									<th className="px-3 py-2 font-medium">対象月</th>
								</tr>
							</thead>
							<tbody>
								{detail.ledger.map((entry) => (
									<tr
										key={entry.id}
										className="border-b border-border last:border-b-0"
									>
										<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
											{formatDateTime(entry.createdAt)}
										</td>
										<td className="px-3 py-2">
											{creditLedgerTypeLabel(entry.type)}
										</td>
										<td
											className={`px-3 py-2 text-right tabular-nums ${entry.amount < 0 ? "text-destructive" : ""}`}
										>
											{entry.amount > 0 ? `+${entry.amount}` : entry.amount}
										</td>
										{/* クレジット(増減)は 1 = $0.001 に量子化された原価なので、
										    量子化前の実原価をここに出す。切り上げぶんの粗利や、
										    見積と実測の乖離が台帳だけで見える。#355 以前の行は null。 */}
										<td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
											{entry.costMicroUsd === null
												? "-"
												: formatMicroUsd(entry.costMicroUsd)}
										</td>
										<td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
											{entry.tokenAmount?.toLocaleString("ja-JP") ?? "-"}
										</td>
										<td className="px-3 py-2 text-muted-foreground">
											{entry.periodMonth}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<p className="mt-2 text-xs text-muted-foreground">
							最新{detail.ledger.length}件を表示
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
