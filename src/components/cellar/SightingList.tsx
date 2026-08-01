import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { MapPinIcon, PlusIcon, StoreIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
	EMPTY_SIGHTING_DRAFT,
	SightingFields,
	type WineSightingDraft,
} from "#/components/cellar/SightingFields";
import {
	buildAddSightingInput,
	buildUpdateSightingInput,
	draftFromSighting,
} from "#/components/cellar/sighting-payload";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import type { WineSightingEntry } from "#/lib/services/drunk-wine-service";
import type { PlaceEntry } from "#/lib/services/place-service";
import {
	addWineSighting,
	deleteWineSighting,
	updateWineSighting,
} from "#/server/drunk-wine";

// 編集画面の目撃記録セクション(Issue #358)。1銘柄を複数の店で見かけられるので、
// 飲用記録(TastingList)と同じ形で 一覧 + 追加 + 行ごとの編集/削除 を扱う。
//
// 一括登録(/cellar/import)で作られた目撃記録には由来の写真があるので、その1枚を
// サムネイルとして出す。「どの店のリストで見たのか」を思い出す手掛かりになる。

export function SightingList({
	entryId,
	sightings,
	places,
	/** 写真のキャッシュバスタ。エントリの updatedAt を渡す */
	version,
}: {
	entryId: string;
	sightings: WineSightingEntry[];
	places: PlaceEntry[];
	version: number;
}) {
	const router = useRouter();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState<WineSightingDraft>(EMPTY_SIGHTING_DRAFT);

	const reset = () => {
		setEditingId(null);
		setAdding(false);
		setDraft(EMPTY_SIGHTING_DRAFT);
		void router.invalidate();
	};

	const save = useMutation({
		mutationFn: async () => {
			if (adding) {
				await addWineSighting({
					data: { drunkWineId: entryId, ...buildAddSightingInput(draft) },
				});
				return;
			}
			if (!editingId) return;
			await updateWineSighting({
				data: buildUpdateSightingInput(editingId, draft),
			});
		},
		onSuccess: reset,
	});

	const remove = useMutation({
		mutationFn: (id: string) => deleteWineSighting({ data: { id } }),
		onSuccess: reset,
	});

	const busy = save.isPending || remove.isPending;

	const editor = (idPrefix: string, submitLabel: string) => (
		<div className="flex flex-col gap-4">
			<SightingFields
				value={draft}
				onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
				places={places}
				idPrefix={idPrefix}
				disabled={busy}
			/>
			<div className="flex gap-2">
				<Button
					type="button"
					size="sm"
					disabled={busy}
					onClick={() => save.mutate()}
				>
					{save.isPending ? "保存中…" : submitLabel}
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
	);

	return (
		<fieldset className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<Label asChild>
					<legend>見かけた記録</legend>
				</Label>
				{!adding && editingId === null && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							setAdding(true);
							setDraft(EMPTY_SIGHTING_DRAFT);
						}}
					>
						<PlusIcon className="size-4" aria-hidden />
						記録を追加
					</Button>
				)}
			</div>

			{sightings.length === 0 && !adding && (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-6">
					<StoreIcon className="size-6 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ見かけた記録がありません。
					</p>
				</div>
			)}

			<ul className="flex flex-col gap-2">
				{sightings.map((sighting) => (
					<li
						key={sighting.id}
						className="rounded-lg border border-border p-3 text-sm"
					>
						{editingId === sighting.id ? (
							editor(`sighting-${sighting.id}`, "保存")
						) : (
							<div className="flex items-start justify-between gap-2">
								<div className="flex min-w-0 items-start gap-3">
									{sighting.photoUrl && (
										// 由来の写真(ワインリスト/棚)。サムネイルは保存していないので
										// 原寸を読む(配信ルートのフォールバックと同じ挙動)
										<img
											src={`${sighting.photoUrl}?v=${version}`}
											alt="見かけたときの写真"
											className="size-14 shrink-0 rounded-md border border-border object-cover"
											loading="lazy"
											decoding="async"
											width={56}
											height={56}
										/>
									)}
									<div className="flex min-w-0 flex-col gap-1">
										<span className="flex items-center gap-1 font-medium">
											<MapPinIcon
												className="size-3.5 text-muted-foreground"
												aria-hidden
											/>
											{sighting.placeName ?? "場所未設定"}
										</span>
										<span className="text-muted-foreground">
											{sighting.seenOn ?? "日付不明"}
											{sighting.price != null &&
												` / ${sighting.price.toLocaleString("ja-JP")}円`}
										</span>
										{sighting.memo && (
											<p className="whitespace-pre-wrap">{sighting.memo}</p>
										)}
									</div>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => {
											setAdding(false);
											setEditingId(sighting.id);
											setDraft(draftFromSighting(sighting));
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
										onClick={() => remove.mutate(sighting.id)}
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
					{editor("sighting-new", "追加")}
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
