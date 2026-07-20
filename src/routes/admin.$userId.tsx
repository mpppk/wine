import {
	createFileRoute,
	Link,
	notFound,
	redirect,
} from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminGetUserDetail } from "#/server/admin";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/admin/$userId")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
		// 非管理者には管理画面の存在を示さず、トップへ黙って戻す。
		if (session.user.role !== "admin") {
			throw redirect({ to: "/" });
		}
	},
	loader: async ({ params }) => {
		const detail = await adminGetUserDetail({
			data: { userId: params.userId },
		});
		if (!detail) throw notFound();
		return detail;
	},
	component: AdminUserDetailPage,
});

function formatDateTime(d: Date): string {
	return d.toLocaleString("ja-JP");
}

function formatDate(d: Date | null): string {
	return d ? d.toLocaleDateString("ja-JP") : "-";
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 py-1.5 text-sm">
			<dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all">{children}</dd>
		</div>
	);
}

const LEDGER_TYPE_LABELS: Record<string, string> = {
	grant: "付与",
	consume: "消費",
	refund: "返却",
};

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
	active: "有効",
	trialing: "トライアル中",
	canceled: "解約済み",
	incomplete: "未完了",
	incomplete_expired: "未完了(期限切れ)",
	past_due: "支払い遅延",
	unpaid: "未払い",
	paused: "一時停止",
};

function BasicInfoCard({ detail }: { detail: AdminUserDetail }) {
	const u = detail.user;
	return (
		<Card>
			<CardHeader>
				<CardTitle>基本情報</CardTitle>
			</CardHeader>
			<CardContent>
				{u.banned && (
					<div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
						<p className="font-medium">このアカウントは利用停止中です</p>
						{u.banReason && <p className="mt-1">理由: {u.banReason}</p>}
						{u.banExpires && (
							<p className="mt-1">解除予定: {formatDateTime(u.banExpires)}</p>
						)}
					</div>
				)}
				<div className="mb-4 flex items-center gap-3">
					{u.image ? (
						<img
							src={u.image}
							alt=""
							className="size-12 rounded-full object-cover"
						/>
					) : (
						<span className="flex size-12 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground">
							{u.name.charAt(0).toUpperCase()}
						</span>
					)}
					<div>
						<p className="font-medium">{u.name}</p>
						<p className="text-sm text-muted-foreground">{u.email}</p>
					</div>
				</div>
				<dl className="divide-y divide-border">
					<InfoRow label="ユーザーID">
						<code className="text-xs">{u.id}</code>
					</InfoRow>
					<InfoRow label="メール確認">
						{u.emailVerified ? "確認済み" : "未確認"}
					</InfoRow>
					<InfoRow label="ロール">{u.role ?? "user"}</InfoRow>
					<InfoRow label="AIモデル設定">{u.preferredAiModel ?? "既定"}</InfoRow>
					<InfoRow label="Stripe顧客ID">
						{u.stripeCustomerId ? (
							<code className="text-xs">{u.stripeCustomerId}</code>
						) : (
							"-"
						)}
					</InfoRow>
					<InfoRow label="登録日時">{formatDateTime(u.createdAt)}</InfoRow>
					<InfoRow label="更新日時">{formatDateTime(u.updatedAt)}</InfoRow>
				</dl>
			</CardContent>
		</Card>
	);
}

function PlanCard({ detail }: { detail: AdminUserDetail }) {
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
											{s.status
												? (SUBSCRIPTION_STATUS_LABELS[s.status] ?? s.status)
												: "-"}
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

function CreditCard({ detail }: { detail: AdminUserDetail }) {
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
											{LEDGER_TYPE_LABELS[entry.type] ?? entry.type}
										</td>
										<td
											className={`px-3 py-2 text-right tabular-nums ${entry.amount < 0 ? "text-destructive" : ""}`}
										>
											{entry.amount > 0 ? `+${entry.amount}` : entry.amount}
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

function CouponCard({ detail }: { detail: AdminUserDetail }) {
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
											<code className="text-xs">{c.code}</code>
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

function AdminUserDetailPage() {
	const detail = Route.useLoaderData();

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6">
				<Link
					to="/admin"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
					ユーザー管理に戻る
				</Link>
			</div>
			<h1 className="mb-6 text-2xl font-bold">ユーザー詳細</h1>
			<div className="flex flex-col gap-6">
				<BasicInfoCard detail={detail} />
				<PlanCard detail={detail} />
				<CreditCard detail={detail} />
				<CouponCard detail={detail} />
			</div>
		</main>
	);
}
