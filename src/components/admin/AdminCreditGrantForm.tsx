import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
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
import {
	ADMIN_CREDIT_GRANT_MAX,
	ADMIN_CREDIT_GRANT_MIN,
	ADMIN_GRANT_REASON_MAX,
} from "#/lib/admin/credit-grant";
import { adminGrantCredits } from "#/server/admin";

/**
 * クレジット手動付与(管理操作)。理由必須・確認ダイアログを挟み、成功後は loader を
 * invalidate して残高・台帳・監査ログの表示を更新する。付与は当月末まで有効(案A)。
 */
export function AdminCreditGrantForm({
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
