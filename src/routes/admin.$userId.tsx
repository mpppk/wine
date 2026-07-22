import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { adminAuditActionLabel } from "#/lib/admin/audit";
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
import { authClient } from "#/lib/auth-client";
import { creditLedgerTypeLabel } from "#/lib/credit/types";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import {
	adminBanUser,
	adminExtendPremium,
	adminGetUserDetail,
	adminGrantCredits,
	adminRevokeMcp,
	adminRevokeSessions,
	adminUnbanUser,
} from "#/server/admin";
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
											{creditLedgerTypeLabel(entry.type)}
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

/**
 * クレジット手動付与(管理操作)。理由必須・確認ダイアログを挟み、成功後は loader を
 * invalidate して残高・台帳・監査ログの表示を更新する。付与は当月末まで有効(案A)。
 */
function AdminCreditGrantForm({
	userId,
	userName,
}: {
	userId: string;
	userName: string;
}) {
	const router = useRouter();
	const [amount, setAmount] = useState("");
	const [reason, setReason] = useState("");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	// 冪等キーは「この付与フォームの1回の送信」に固定し、再送で二重付与しないようにする。
	const requestIdRef = useRef<string | null>(null);

	const parsedAmount = Number(amount);
	const amountValid =
		amount.trim() !== "" &&
		Number.isInteger(parsedAmount) &&
		parsedAmount >= ADMIN_CREDIT_GRANT_MIN &&
		parsedAmount <= ADMIN_CREDIT_GRANT_MAX;
	const reasonValid = reason.trim().length > 0;
	const canSubmit = amountValid && reasonValid;

	const { mutate, isPending } = useMutation({
		mutationFn: async () => {
			if (!requestIdRef.current) {
				requestIdRef.current = `admin_grant:${crypto.randomUUID()}`;
			}
			return adminGrantCredits({
				data: {
					userId,
					amount: parsedAmount,
					reason: reason.trim(),
					requestId: requestIdRef.current,
				},
			});
		},
		onSuccess: async (result) => {
			setConfirmOpen(false);
			setError("");
			setAmount("");
			setReason("");
			requestIdRef.current = null;
			setMessage(
				result.alreadyApplied
					? `既に付与済みでした(残高: ${result.balanceAfter.toLocaleString("ja-JP")})。`
					: `${result.grantedAmount.toLocaleString("ja-JP")} クレジットを付与しました(残高: ${result.balanceAfter.toLocaleString("ja-JP")})。`,
			);
			await router.invalidate();
		},
		onError: (err: Error) => {
			setConfirmOpen(false);
			setMessage("");
			setError(err.message || "付与に失敗しました。");
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>クレジット付与(管理操作)</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					障害補填・お詫びとしてクレジットを付与します。付与分は当月残高に加算され、
					<strong className="font-medium text-foreground">
						当月末まで有効
					</strong>
					です(翌月の月次付与でリセットされます)。
				</p>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="grant-amount">付与クレジット数</Label>
					<Input
						id="grant-amount"
						type="number"
						inputMode="numeric"
						min={ADMIN_CREDIT_GRANT_MIN}
						max={ADMIN_CREDIT_GRANT_MAX}
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
						placeholder="例: 100"
						className="max-w-xs"
						disabled={isPending}
					/>
					<p className="text-xs text-muted-foreground">
						{ADMIN_CREDIT_GRANT_MIN}〜
						{ADMIN_CREDIT_GRANT_MAX.toLocaleString("ja-JP")}{" "}
						の整数で指定します。
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="grant-reason">理由(必須)</Label>
					<Textarea
						id="grant-reason"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="例: 2026-07-20 の障害によるAI機能停止のお詫び"
						rows={2}
						maxLength={ADMIN_GRANT_REASON_MAX}
						disabled={isPending}
					/>
				</div>
				{message && (
					<p className="text-sm text-green-600 dark:text-green-400">
						{message}
					</p>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Button
					type="button"
					className="self-start"
					disabled={!canSubmit || isPending}
					onClick={() => {
						setMessage("");
						setError("");
						setConfirmOpen(true);
					}}
				>
					クレジットを付与
				</Button>
				<Dialog
					open={confirmOpen}
					onOpenChange={(o) => {
						if (!isPending) setConfirmOpen(o);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>クレジット付与の確認</DialogTitle>
							<DialogDescription>
								この操作は監査ログに記録されます。
							</DialogDescription>
						</DialogHeader>
						<dl className="flex flex-col gap-2 text-sm">
							<div className="flex justify-between gap-4">
								<dt className="shrink-0 text-muted-foreground">対象</dt>
								<dd className="break-all text-right">{userName}</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="shrink-0 text-muted-foreground">付与数</dt>
								<dd className="font-bold tabular-nums">
									{amountValid ? parsedAmount.toLocaleString("ja-JP") : "-"}
								</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="shrink-0 text-muted-foreground">理由</dt>
								<dd className="break-all text-right">{reason.trim()}</dd>
							</div>
						</dl>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={isPending}
								onClick={() => setConfirmOpen(false)}
							>
								キャンセル
							</Button>
							<Button
								type="button"
								disabled={isPending || !canSubmit}
								onClick={() => mutate()}
							>
								{isPending ? "付与中..." : "付与する"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
}

function AuditLogCard({ detail }: { detail: AdminUserDetail }) {
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

/**
 * プレミアム期間延長(管理操作, 案b)。プレミアム会員のみ延長でき、無料ユーザには不可の旨を
 * 表示する。理由必須・確認ダイアログを挟み、成功後は loader を invalidate する。
 */
function AdminPremiumExtensionForm({ detail }: { detail: AdminUserDetail }) {
	const router = useRouter();
	const isPremium = detail.plan === "premium";
	const [days, setDays] = useState("");
	const [reason, setReason] = useState("");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const parsedDays = Number(days);
	const daysValid =
		days.trim() !== "" &&
		Number.isInteger(parsedDays) &&
		parsedDays >= ADMIN_EXTENSION_MIN_DAYS &&
		parsedDays <= ADMIN_EXTENSION_MAX_DAYS;
	const reasonValid = reason.trim().length > 0;
	const canSubmit = isPremium && daysValid && reasonValid;

	const { mutate, isPending } = useMutation({
		mutationFn: () =>
			adminExtendPremium({
				data: {
					userId: detail.user.id,
					days: parsedDays,
					reason: reason.trim(),
				},
			}),
		onSuccess: async (result) => {
			setConfirmOpen(false);
			setError("");
			setDays("");
			setReason("");
			const until = new Date(result.newPeriodEnd).toLocaleDateString("ja-JP");
			setMessage(
				`${result.extendedDays}日延長しました(次回請求日: ${until}。反映まで少し時間がかかる場合があります)。`,
			);
			await router.invalidate();
		},
		onError: (err: Error) => {
			setConfirmOpen(false);
			setMessage("");
			setError(err.message || "延長に失敗しました。");
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>プレミアム期間延長(管理操作)</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{!isPremium ? (
					<p className="text-sm text-muted-foreground">
						プレミアム会員のみ延長できます。無料プランのユーザへのお詫びは上の「クレジット付与」をご利用ください。
					</p>
				) : (
					<>
						<p className="text-sm text-muted-foreground">
							お詫びとしてプレミアム期間を延長します(Stripe
							の次回請求日を後ろ倒し。日割り請求なし)。即時反映されます。
						</p>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ext-days">延長日数</Label>
							<Input
								id="ext-days"
								type="number"
								inputMode="numeric"
								min={ADMIN_EXTENSION_MIN_DAYS}
								max={ADMIN_EXTENSION_MAX_DAYS}
								value={days}
								onChange={(e) => setDays(e.target.value)}
								placeholder="例: 7"
								className="max-w-xs"
								disabled={isPending}
							/>
							<p className="text-xs text-muted-foreground">
								{ADMIN_EXTENSION_MIN_DAYS}〜{ADMIN_EXTENSION_MAX_DAYS}{" "}
								日の整数で指定します。
							</p>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ext-reason">理由(必須)</Label>
							<Textarea
								id="ext-reason"
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								placeholder="例: 2026-07-20 の障害によるプレミアム機能停止のお詫び"
								rows={2}
								maxLength={ADMIN_GRANT_REASON_MAX}
								disabled={isPending}
							/>
						</div>
						{message && (
							<p className="text-sm text-green-600 dark:text-green-400">
								{message}
							</p>
						)}
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button
							type="button"
							className="self-start"
							disabled={!canSubmit || isPending}
							onClick={() => {
								setMessage("");
								setError("");
								setConfirmOpen(true);
							}}
						>
							期間を延長
						</Button>
						<Dialog
							open={confirmOpen}
							onOpenChange={(o) => {
								if (!isPending) setConfirmOpen(o);
							}}
						>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>プレミアム期間延長の確認</DialogTitle>
									<DialogDescription>
										Stripe
										の次回請求日を延長します。この操作は監査ログに記録されます。
									</DialogDescription>
								</DialogHeader>
								<dl className="flex flex-col gap-2 text-sm">
									<div className="flex justify-between gap-4">
										<dt className="shrink-0 text-muted-foreground">対象</dt>
										<dd className="break-all text-right">{detail.user.name}</dd>
									</div>
									<div className="flex justify-between gap-4">
										<dt className="shrink-0 text-muted-foreground">延長日数</dt>
										<dd className="font-bold tabular-nums">
											{daysValid ? `${parsedDays}日` : "-"}
										</dd>
									</div>
									<div className="flex justify-between gap-4">
										<dt className="shrink-0 text-muted-foreground">理由</dt>
										<dd className="break-all text-right">{reason.trim()}</dd>
									</div>
								</dl>
								<DialogFooter>
									<Button
										type="button"
										variant="outline"
										disabled={isPending}
										onClick={() => setConfirmOpen(false)}
									>
										キャンセル
									</Button>
									<Button
										type="button"
										disabled={isPending || !canSubmit}
										onClick={() => mutate()}
									>
										{isPending ? "延長中..." : "延長する"}
									</Button>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * 破壊的操作の共通ボタン+確認ダイアログ(理由必須)。成功後 loader を invalidate する。
 * BAN のように追加入力が必要な操作は専用フォームを使う。
 */
function DangerAction({
	label,
	confirmTitle,
	confirmBody,
	mutationFn,
	buttonVariant = "destructive",
	doneMessage,
	disabled,
	disabledNote,
}: {
	label: string;
	confirmTitle: string;
	confirmBody: string;
	mutationFn: (reason: string) => Promise<unknown>;
	buttonVariant?: "destructive" | "outline";
	doneMessage: string;
	disabled?: boolean;
	disabledNote?: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");

	const { mutate, isPending } = useMutation({
		mutationFn: () => mutationFn(reason.trim()),
		onSuccess: async () => {
			setOpen(false);
			setReason("");
			setError("");
			setMessage(doneMessage);
			await router.invalidate();
		},
		onError: (err: Error) => setError(err.message || "操作に失敗しました。"),
	});

	return (
		<div className="flex flex-col gap-2">
			<Button
				type="button"
				variant={buttonVariant}
				size="sm"
				className="self-start"
				disabled={disabled}
				onClick={() => {
					setError("");
					setMessage("");
					setReason("");
					setOpen(true);
				}}
			>
				{label}
			</Button>
			{disabled && disabledNote && (
				<p className="text-xs text-muted-foreground">{disabledNote}</p>
			)}
			{message && (
				<p className="text-sm text-green-600 dark:text-green-400">{message}</p>
			)}
			<Dialog
				open={open}
				onOpenChange={(o) => {
					if (!isPending) setOpen(o);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{confirmTitle}</DialogTitle>
						<DialogDescription>
							{confirmBody} この操作は監査ログに記録されます。
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label>理由(必須)</Label>
						<Textarea
							aria-label="理由"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							rows={2}
							maxLength={ADMIN_GRANT_REASON_MAX}
							disabled={isPending}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={isPending}
							onClick={() => setOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant={buttonVariant === "outline" ? "default" : "destructive"}
							disabled={isPending || reason.trim() === ""}
							onClick={() => mutate()}
						>
							{isPending ? "処理中..." : "実行する"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** BAN(理由必須+任意の期限)。BAN 中は解除アクションを出す。自分自身には実行不可。 */
function BanControl({
	detail,
	isSelf,
}: {
	detail: AdminUserDetail;
	isSelf: boolean;
}) {
	const router = useRouter();
	const u = detail.user;
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [days, setDays] = useState("");
	const [error, setError] = useState("");

	const parsedDays = Number(days);
	const daysEmpty = days.trim() === "";
	const daysValid =
		daysEmpty ||
		(Number.isInteger(parsedDays) &&
			parsedDays >= BAN_EXPIRES_MIN_DAYS &&
			parsedDays <= BAN_EXPIRES_MAX_DAYS);
	const canSubmit = reason.trim() !== "" && daysValid;

	const { mutate, isPending } = useMutation({
		mutationFn: () =>
			adminBanUser({
				data: {
					userId: u.id,
					reason: reason.trim(),
					expiresInDays: daysEmpty ? undefined : parsedDays,
				},
			}),
		onSuccess: async () => {
			setOpen(false);
			setReason("");
			setDays("");
			setError("");
			await router.invalidate();
		},
		onError: (err: Error) =>
			setError(err.message || "利用停止に失敗しました。"),
	});

	if (u.banned) {
		return (
			<DangerAction
				label="利用停止を解除"
				buttonVariant="outline"
				confirmTitle="利用停止の解除"
				confirmBody={`${u.name} の利用停止を解除します。`}
				doneMessage="利用停止を解除しました。"
				mutationFn={(r) =>
					adminUnbanUser({ data: { userId: u.id, reason: r } })
				}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			<Button
				type="button"
				variant="destructive"
				size="sm"
				className="self-start"
				disabled={isSelf}
				onClick={() => {
					setError("");
					setReason("");
					setDays("");
					setOpen(true);
				}}
			>
				利用停止(BAN)
			</Button>
			{isSelf && (
				<p className="text-xs text-muted-foreground">
					自分自身は利用停止できません。
				</p>
			)}
			<Dialog
				open={open}
				onOpenChange={(o) => {
					if (!isPending) setOpen(o);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>利用停止(BAN)の確認</DialogTitle>
						<DialogDescription>
							{u.name}{" "}
							を利用停止します。停止中はログインが拒否され、既存セッションも失効します。この操作は監査ログに記録されます。
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ban-days">停止期限(日数・空欄で無期限)</Label>
						<Input
							id="ban-days"
							type="number"
							inputMode="numeric"
							min={BAN_EXPIRES_MIN_DAYS}
							max={BAN_EXPIRES_MAX_DAYS}
							value={days}
							onChange={(e) => setDays(e.target.value)}
							placeholder="無期限"
							className="max-w-xs"
							disabled={isPending}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ban-reason">理由(必須)</Label>
						<Textarea
							id="ban-reason"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							placeholder="例: 規約違反(スパム投稿)"
							rows={2}
							maxLength={ADMIN_GRANT_REASON_MAX}
							disabled={isPending}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={isPending}
							onClick={() => setOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={isPending || !canSubmit}
							onClick={() => mutate()}
						>
							{isPending ? "処理中..." : "利用停止する"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function ModerationCard({
	detail,
	isSelf,
}: {
	detail: AdminUserDetail;
	isSelf: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>モデレーション(管理操作)</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				<p className="text-sm text-muted-foreground">
					アカウント乗っ取り疑い・規約違反への対応。停止・失効は監査ログに記録されます。
				</p>
				<BanControl detail={detail} isSelf={isSelf} />
			</CardContent>
		</Card>
	);
}

function SessionCard({
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

function McpCard({ detail }: { detail: AdminUserDetail }) {
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

function AdminUserDetailPage() {
	const detail = Route.useLoaderData();
	const { data: session } = authClient.useSession();
	const isSelf = session?.user.id === detail.user.id;

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
				<ModerationCard detail={detail} isSelf={isSelf} />
				<PlanCard detail={detail} />
				<SessionCard detail={detail} isSelf={isSelf} />
				<McpCard detail={detail} />
				<CreditCard detail={detail} />
				<AdminCreditGrantForm
					userId={detail.user.id}
					userName={detail.user.name}
				/>
				<AdminPremiumExtensionForm detail={detail} />
				<CouponCard detail={detail} />
				<AuditLogCard detail={detail} />
			</div>
		</main>
	);
}
