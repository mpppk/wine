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
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { ADMIN_GRANT_REASON_MAX } from "#/lib/admin/credit-grant";

/**
 * 破壊的操作の共通ボタン+確認ダイアログ(理由必須)。成功後 loader を invalidate する。
 * BAN のように追加入力が必要な操作は専用フォームを使う。
 */
export function DangerAction({
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
