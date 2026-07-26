import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon, WineIcon } from "lucide-react";
import { useState } from "react";
import {
	EMPTY_TASTING_DRAFT,
	type WineTastingDraft,
} from "#/components/cellar/drunk-wine-payload";
import { RatingStars } from "#/components/cellar/RatingStars";
import { TastingFields } from "#/components/cellar/TastingFields";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import type { WineTastingEntry } from "#/lib/services/drunk-wine-service";
import {
	addWineTasting,
	deleteWineTasting,
	updateWineTasting,
} from "#/server/drunk-wine";

// 編集画面の飲用記録セクション。1銘柄に複数の記録を持てるので、一覧 + 追加 +
// 行ごとの編集/削除を扱う。新規作成画面は記録が1件も無いので TastingFields を
// 直接使う(DrunkWineForm 側で出し分ける)。

function draftFromEntry(entry: WineTastingEntry): WineTastingDraft {
	return {
		drankOn: entry.drankOn ?? "",
		rating: entry.rating,
		memo: entry.memo ?? "",
	};
}

export function TastingList({
	entryId,
	tastings,
}: {
	entryId: string;
	tastings: WineTastingEntry[];
}) {
	const router = useRouter();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<WineTastingDraft>(EMPTY_TASTING_DRAFT);

	const reset = () => {
		setEditingId(null);
		setAdding(false);
		setDraft(EMPTY_TASTING_DRAFT);
		void router.invalidate();
	};

	const save = useMutation({
		mutationFn: async () => {
			if (adding) {
				await addWineTasting({
					data: {
						drunkWineId: entryId,
						drankOn: draft.drankOn || undefined,
						rating: draft.rating ?? undefined,
						memo: draft.memo.trim() || undefined,
					},
				});
				return;
			}
			if (!editingId) return;
			// 空欄は null(クリア)として送る。銘柄フォームと同じ規約
			await updateWineTasting({
				data: {
					id: editingId,
					drankOn: draft.drankOn || null,
					rating: draft.rating,
					memo: draft.memo.trim() || null,
				},
			});
		},
		onSuccess: reset,
	});

	const remove = useMutation({
		mutationFn: (id: string) => deleteWineTasting({ data: { id } }),
		onSuccess: reset,
	});

	const busy = save.isPending || remove.isPending;

	return (
		<fieldset className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<Label asChild>
					<legend>飲んだ記録</legend>
				</Label>
				{!adding && editingId === null && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							setAdding(true);
							setDraft(EMPTY_TASTING_DRAFT);
						}}
					>
						<PlusIcon className="size-4" aria-hidden />
						記録を追加
					</Button>
				)}
			</div>

			{tastings.length === 0 && !adding && (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-6">
					<WineIcon className="size-6 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ飲んだ記録がありません。
					</p>
				</div>
			)}

			<ul className="flex flex-col gap-2">
				{tastings.map((tasting) => (
					<li
						key={tasting.id}
						className="rounded-lg border border-border p-3 text-sm"
					>
						{editingId === tasting.id ? (
							<div className="flex flex-col gap-4">
								<TastingFields
									value={draft}
									onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
									idPrefix={`tasting-${tasting.id}`}
									disabled={busy}
								/>
								<div className="flex gap-2">
									<Button
										type="button"
										size="sm"
										disabled={busy}
										onClick={() => save.mutate()}
									>
										{save.isPending ? "保存中…" : "保存"}
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={reset}
									>
										キャンセル
									</Button>
								</div>
							</div>
						) : (
							<div className="flex items-start justify-between gap-2">
								<div className="flex flex-col gap-1">
									<span className="text-muted-foreground">
										{tasting.drankOn ?? "日付不明"}
									</span>
									{tasting.rating !== null && (
										<RatingStars rating={tasting.rating} />
									)}
									{tasting.memo && (
										<p className="whitespace-pre-wrap">{tasting.memo}</p>
									)}
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => {
											setAdding(false);
											setEditingId(tasting.id);
											setDraft(draftFromEntry(tasting));
										}}
									>
										編集
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label="この記録を削除"
										disabled={busy}
										onClick={() => remove.mutate(tasting.id)}
									>
										<Trash2Icon className="size-4" />
									</Button>
								</div>
							</div>
						)}
					</li>
				))}
			</ul>

			{adding && (
				<div className="flex flex-col gap-4 rounded-lg border border-border p-3">
					<TastingFields
						value={draft}
						onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
						idPrefix="tasting-new"
						disabled={busy}
					/>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							disabled={busy}
							onClick={() => save.mutate()}
						>
							{save.isPending ? "追加中…" : "追加"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={reset}
						>
							キャンセル
						</Button>
					</div>
				</div>
			)}

			{(save.isError || remove.isError) && (
				<p className="text-sm text-destructive">
					保存に失敗しました。時間をおいて再度お試しください。
				</p>
			)}
		</fieldset>
	);
}
