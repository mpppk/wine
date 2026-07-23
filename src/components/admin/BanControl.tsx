import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
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
	BAN_EXPIRES_MAX_DAYS,
	BAN_EXPIRES_MIN_DAYS,
} from "#/lib/admin/moderation";
import type { AdminUserDetail } from "#/lib/services/admin-service";
import { adminBanUser, adminUnbanUser } from "#/server/admin";
import { DangerAction } from "./DangerAction";

/** BAN(理由必須+任意の期限)。BAN 中は解除アクションを出す。自分自身には実行不可。 */
export function BanControl({
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
