import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowLeftIcon, ImageIcon } from "lucide-react";
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
import { formatDateTimeJst } from "#/lib/date/display";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import type { ImportBatchSummary } from "#/lib/services/drunk-wine-service";
import { listImportBatches, undoImportBatch } from "#/server/place";

// 過去の一括登録バッチの一覧・後からの取り消し(Issue #380)。#378 は取り消し導線を
// `/cellar/import` の登録直後の完了画面だけに限定したが、そこを離れた後に
// 「やっぱりあの一括登録は間違いだった」に対応する導線がここ。

export const Route = createFileRoute("/cellar/import/history")({
	beforeLoad: requireAuthBeforeLoad,
	loader: () => listImportBatches(),
	component: CellarImportHistoryPage,
});

function CellarImportHistoryPage() {
	const initialBatches = Route.useLoaderData();
	const router = useRouter();
	const [batches, setBatches] = useState(initialBatches);
	const [target, setTarget] = useState<ImportBatchSummary | null>(null);
	const [undoError, setUndoError] = useState("");

	const { mutate: undoBatch, isPending: isUndoing } = useMutation({
		mutationFn: (batchId: string) => undoImportBatch({ data: { batchId } }),
		onSuccess: (_, batchId) => {
			setBatches((prev) => prev.filter((b) => b.id !== batchId));
			setTarget(null);
			setUndoError("");
			// 一覧に居ないマイセラー側(件数チップ等)の表示を合わせる
			router.invalidate();
		},
		onError: (e: Error) => setUndoError(e.message || "取り消しに失敗しました"),
	});

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					aria-label="マイセラーへ戻る"
				>
					<Link to="/cellar">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<h1 className="text-2xl font-bold">一括登録の履歴</h1>
			</div>

			{batches.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
					過去の一括登録はありません。
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{batches.map((batch) => (
						<li
							key={batch.id}
							className="rounded-lg border border-border p-4 text-sm"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="flex flex-col gap-1">
									<p className="font-medium">
										{formatDateTimeJst(new Date(batch.createdAt))}
									</p>
									<p className="text-muted-foreground">
										{batch.placeName ?? "場所の指定なし"}
										{batch.seenOn && `・${batch.seenOn}に見かけた`}
									</p>
									<p className="flex items-center gap-1 text-muted-foreground">
										<ImageIcon className="size-3.5" aria-hidden />
										写真{batch.photoCount}枚・新規{batch.createdCount}件
										{batch.matchedCount > 0 &&
											`・既存へ追加${batch.matchedCount}件`}
									</p>
									{batch.hasEditedEntries && (
										<p className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
											<AlertTriangleIcon className="size-3.5" aria-hidden />
											登録後に編集された銘柄が含まれています
										</p>
									)}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="shrink-0"
									onClick={() => {
										setUndoError("");
										setTarget(batch);
									}}
								>
									取り消す
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}

			<Dialog
				open={target != null}
				onOpenChange={(open) => !open && setTarget(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>この登録を取り消しますか?</DialogTitle>
						<DialogDescription>
							{target &&
								`新規作成した${target.createdCount}件の銘柄と、既存の銘柄に追加した目撃記録を取り消します。写真も削除されます。`}
							{target?.hasEditedEntries &&
								" 登録後に編集した内容も失われます。"}
							{" この操作は取り消せません。"}
						</DialogDescription>
					</DialogHeader>
					{undoError && <p className="text-sm text-destructive">{undoError}</p>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={isUndoing}
							onClick={() => setTarget(null)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={isUndoing}
							onClick={() => target && undoBatch(target.id)}
						>
							{isUndoing ? "取り消し中…" : "取り消す"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}
