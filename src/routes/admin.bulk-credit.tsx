import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
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
import { ADMIN_INCIDENT_ID_PATTERN } from "#/lib/admin/bulk-credit";
import {
	ADMIN_CREDIT_GRANT_MAX,
	ADMIN_CREDIT_GRANT_MIN,
	ADMIN_GRANT_REASON_MAX,
} from "#/lib/admin/credit-grant";
import { adminBulkGrantCredits, adminBulkGrantPreview } from "#/server/admin";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/admin/bulk-credit")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
		if (session.user.role !== "admin") {
			throw redirect({ to: "/" });
		}
	},
	component: BulkCreditPage,
});

function toMs(v: string): number {
	return v ? new Date(v).getTime() : Number.NaN;
}

function BulkCreditPage() {
	const [incidentId, setIncidentId] = useState("");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [amount, setAmount] = useState("");
	const [reason, setReason] = useState("");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const fromMs = toMs(from);
	const toMsVal = toMs(to);
	const parsedAmount = Number(amount);
	const incidentTrimmed = incidentId.trim();
	const incidentValid =
		incidentTrimmed !== "" && ADMIN_INCIDENT_ID_PATTERN.test(incidentTrimmed);
	const amountValid =
		amount.trim() !== "" &&
		Number.isInteger(parsedAmount) &&
		parsedAmount >= ADMIN_CREDIT_GRANT_MIN &&
		parsedAmount <= ADMIN_CREDIT_GRANT_MAX;
	const rangeValid =
		Number.isFinite(fromMs) && Number.isFinite(toMsVal) && fromMs < toMsVal;
	const reasonValid = reason.trim() !== "";

	const previewM = useMutation({
		mutationFn: () =>
			adminBulkGrantPreview({ data: { fromMs, toMs: toMsVal } }),
		onError: (err: Error) => setError(err.message),
	});
	const applyM = useMutation({
		mutationFn: () =>
			adminBulkGrantCredits({
				data: {
					incidentId: incidentTrimmed,
					fromMs,
					toMs: toMsVal,
					amount: parsedAmount,
					reason: reason.trim(),
				},
			}),
		onSuccess: (r) => {
			setConfirmOpen(false);
			setError("");
			previewM.reset();
			setMessage(
				`付与完了: 対象 ${r.affected} 人 / 新規付与 ${r.granted} 人（${r.totalGranted.toLocaleString("ja-JP")} クレジット）/ 既付与スキップ ${r.alreadyApplied} 人`,
			);
		},
		onError: (err: Error) => {
			setConfirmOpen(false);
			setError(err.message || "一括付与に失敗しました。");
		},
	});

	const preview = previewM.data;
	// 期間・付与額を変えたらプレビューを無効化し、再プレビューを促す。
	const invalidatePreview = () => {
		previewM.reset();
		setMessage("");
		setError("");
	};
	const canPreview = rangeValid && !previewM.isPending;
	const canApply =
		incidentValid && amountValid && rangeValid && reasonValid && !!preview;

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6">
				<Link
					to="/admin"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-4" aria-hidden />
					ユーザー管理に戻る
				</Link>
			</div>
			<h1 className="mb-6 text-2xl font-bold">一括クレジット補填</h1>
			<Card>
				<CardHeader>
					<CardTitle>障害補填（一括付与）</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						指定期間内にAIクレジットを消費したユーザ（＝障害の影響を受けたユーザ）へまとめてクレジットを付与します。付与分は
						<strong className="font-medium text-foreground">
							当月末まで有効
						</strong>
						（#113
						と同じ）。同一インシデントIDでの再実行は二重付与しません（冪等）。
					</p>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="incident-id">
							インシデントID（冪等キー・必須）
						</Label>
						<Input
							id="incident-id"
							value={incidentId}
							onChange={(e) => {
								setIncidentId(e.target.value);
								setMessage("");
							}}
							placeholder="例: incident-2026-07-20-ai-outage"
							className="max-w-md"
							disabled={applyM.isPending}
						/>
						<p className="text-xs text-muted-foreground">
							英数・ハイフン・アンダースコアのみ。障害ごとに一意にしてください。
						</p>
					</div>

					<div className="flex flex-wrap gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="from">対象期間（開始）</Label>
							<Input
								id="from"
								type="datetime-local"
								value={from}
								onChange={(e) => {
									setFrom(e.target.value);
									invalidatePreview();
								}}
								disabled={applyM.isPending}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="to">対象期間（終了）</Label>
							<Input
								id="to"
								type="datetime-local"
								value={to}
								onChange={(e) => {
									setTo(e.target.value);
									invalidatePreview();
								}}
								disabled={applyM.isPending}
							/>
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="bulk-amount">1人あたり付与クレジット数</Label>
						<Input
							id="bulk-amount"
							type="number"
							inputMode="numeric"
							min={ADMIN_CREDIT_GRANT_MIN}
							max={ADMIN_CREDIT_GRANT_MAX}
							value={amount}
							onChange={(e) => {
								setAmount(e.target.value);
								setMessage("");
							}}
							placeholder="例: 100"
							className="max-w-xs"
							disabled={applyM.isPending}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="bulk-reason">理由（必須）</Label>
						<Textarea
							id="bulk-reason"
							value={reason}
							onChange={(e) => {
								setReason(e.target.value);
								setMessage("");
							}}
							placeholder="例: 2026-07-20 のAI機能障害のお詫び"
							rows={2}
							maxLength={ADMIN_GRANT_REASON_MAX}
							disabled={applyM.isPending}
						/>
					</div>

					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							variant="outline"
							disabled={!canPreview}
							onClick={() => {
								setError("");
								setMessage("");
								previewM.mutate();
							}}
						>
							{previewM.isPending ? "集計中..." : "対象をプレビュー"}
						</Button>
						{preview && (
							<span className="text-sm">
								対象{" "}
								<span className="font-bold tabular-nums">
									{preview.affected.toLocaleString("ja-JP")}
								</span>{" "}
								人
								{amountValid && (
									<>
										{" "}
										/ 付与総額{" "}
										<span className="font-bold tabular-nums">
											{(preview.affected * parsedAmount).toLocaleString(
												"ja-JP",
											)}
										</span>{" "}
										クレジット
									</>
								)}
							</span>
						)}
					</div>
					{preview?.capped && (
						<p className="text-sm text-destructive">
							対象が上限（{preview.maxUsers.toLocaleString("ja-JP")}
							人）を超えています。期間を絞ってください（この状態では実行できません）。
						</p>
					)}

					{message && (
						<p className="text-sm text-green-600 dark:text-green-400">
							{message}
						</p>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}

					<Button
						type="button"
						className="self-start"
						disabled={!canApply || applyM.isPending || preview?.capped}
						onClick={() => {
							setError("");
							setMessage("");
							setConfirmOpen(true);
						}}
					>
						一括付与を実行
					</Button>
					{!preview && (
						<p className="text-xs text-muted-foreground">
							実行の前に「対象をプレビュー」で対象人数をご確認ください。
						</p>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={confirmOpen}
				onOpenChange={(o) => {
					if (!applyM.isPending) setConfirmOpen(o);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>一括クレジット付与の確認</DialogTitle>
						<DialogDescription>
							この操作は監査ログに記録されます。同一インシデントIDでの再実行は二重付与しません。
						</DialogDescription>
					</DialogHeader>
					<dl className="flex flex-col gap-2 text-sm">
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted-foreground">インシデントID</dt>
							<dd className="break-all text-right">{incidentTrimmed}</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted-foreground">対象人数</dt>
							<dd className="font-bold tabular-nums">
								{preview?.affected.toLocaleString("ja-JP") ?? "-"} 人
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted-foreground">1人あたり</dt>
							<dd className="tabular-nums">
								{amountValid ? parsedAmount.toLocaleString("ja-JP") : "-"}{" "}
								クレジット
							</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="shrink-0 text-muted-foreground">
								付与総額（最大）
							</dt>
							<dd className="font-bold tabular-nums">
								{preview && amountValid
									? (preview.affected * parsedAmount).toLocaleString("ja-JP")
									: "-"}{" "}
								クレジット
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
							disabled={applyM.isPending}
							onClick={() => setConfirmOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							disabled={applyM.isPending || !canApply}
							onClick={() => applyM.mutate()}
						>
							{applyM.isPending ? "付与中..." : "実行する"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}
