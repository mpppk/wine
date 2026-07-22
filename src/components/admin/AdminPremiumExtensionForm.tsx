import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
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
import { ADMIN_GRANT_REASON_MAX } from "#/lib/admin/credit-grant";
import {
	ADMIN_EXTENSION_MAX_DAYS,
	ADMIN_EXTENSION_MIN_DAYS,
} from "#/lib/admin/premium-extension";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminExtendPremium } from "#/server/admin";

/**
 * プレミアム期間延長(管理操作, 案b)。プレミアム会員のみ延長でき、無料ユーザには不可の旨を
 * 表示する。理由必須・確認ダイアログを挟み、成功後は loader を invalidate する。
 */
export function AdminPremiumExtensionForm({
	detail,
}: {
	detail: AdminUserDetail;
}) {
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
