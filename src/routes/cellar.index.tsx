import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	HistoryIcon,
	ImagesIcon,
	ListChecksIcon,
	MapIcon,
	PlusIcon,
	Trash2Icon,
	WineIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { CellarFilterChips } from "#/components/cellar/CellarFilterChips";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import {
	CELLAR_FILTER_IDS,
	DEFAULT_CELLAR_FILTER,
} from "#/lib/drunk-wine/filter";
import { DRUNK_WINE_PAGE_SIZE } from "#/lib/drunk-wine/pagination";
import { BULK_DELETE_MAX } from "#/lib/drunk-wine/schema";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { provenanceNameJa } from "#/lib/wine/provenance";
import { getWineListAnalysisAvailability } from "#/server/ai";
import {
	countCellarFilters,
	deleteDrunkWines,
	listDrunkWines,
	markWineDrunk,
} from "#/server/drunk-wine";
import { listPlaces } from "#/server/place";

/** 「すべての場所」の選択値。Select は空文字を未選択と解釈するため別の値にする。 */
const ALL_PLACES = "__all__";

export const Route = createFileRoute("/cellar/")({
	// 絞り込みは URL に載せる。地図(/cellar/map)との相互リンクで引き継ぐことが
	// 「両ページで連動」の実装手段になる。
	// catch: 不正値(?filter=xxx)は既定へ黙って倒す。
	// default: 未指定も許す(これが無いと /cellar への全リンクで search が必須になる)。
	validateSearch: z.object({
		filter: z
			.enum(CELLAR_FILTER_IDS)
			.catch(DEFAULT_CELLAR_FILTER)
			.default(DEFAULT_CELLAR_FILTER),
		// 場所での絞り込み(その店で見かけた銘柄だけ)。所有状態のチップとは直交する
		// 軸なので別のパラメータで持つ。既に消した場所のIDが URL に残っていても
		// 一覧が0件になるだけなので、既定へ倒さずそのまま通す。
		place: z.string().max(80).optional().catch(undefined),
	}),
	beforeLoad: requireAuthBeforeLoad,
	// 絞り込みは SQL 側で適用する。ページに載っていない行も数えるため、チップの
	// 件数は集計クエリで別に取る(#254)。
	loaderDeps: ({ search }) => ({ filter: search.filter, place: search.place }),
	loader: async ({ deps }) => {
		// 一括登録は Claude 専用の経路で、キーが無い環境では使えない。導線ごと
		// 隠すため、判定を一覧のロードで一緒に取る(サーバ側の 503 と同じ判定)。
		const [page, counts, wineListAnalysis, places] = await Promise.all([
			listDrunkWines({
				data: {
					filter: deps.filter,
					...(deps.place ? { placeId: deps.place } : {}),
					limit: DRUNK_WINE_PAGE_SIZE,
				},
			}),
			// チップの件数も場所で絞った母集合で数える(数字と一覧の食い違いを防ぐ)
			countCellarFilters({ data: deps.place ? { placeId: deps.place } : {} }),
			getWineListAnalysisAvailability(),
			listPlaces(),
		]);
		return { page, counts, wineListAnalysis, places };
	},
	component: CellarPage,
});

function EntryCard({
	entry,
	selectMode,
	selected,
	onToggleSelect,
}: {
	entry: DrunkWineEntry;
	selectMode: boolean;
	selected: boolean;
	onToggleSelect: (id: string) => void;
}) {
	// AOP名 > 地域名 > 国名(粗い紐付けのエントリも産地が見えるようにする)
	const provenance = provenanceNameJa(entry);
	const router = useRouter();
	const drink = useMutation({
		mutationFn: () => markWineDrunk({ data: { id: entry.id } }),
		onSuccess: () => router.invalidate(),
	});

	return (
		// カード全体は閲覧画面へのリンク。「飲んだ」ボタンをリンクの中には入れられない
		// (<a> 内の interactive nesting になり、クリックもリンクへ吸われる)。
		// 兄弟として絶対配置する。選択モード中はカード全体がチェック切り替えに変わる
		// (Issue #363 案B)ので、Link のクリックを奪って遷移させない。
		<div className="relative h-full">
			<Link
				to="/cellar/$entryId"
				params={{ entryId: entry.id }}
				className="group block h-full"
				onClick={(e) => {
					if (!selectMode) return;
					e.preventDefault();
					onToggleSelect(entry.id);
				}}
			>
				<Card className="h-full gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/30">
					{entry.thumbUrls[0] ? (
						<img
							// 写真差し替え時にR2キーが同じでも再取得させるキャッシュバスタ。
							// 一覧サムネイルは代表(先頭)の1枚。原寸ではなく縮小版を読む(#237)。
							// サムネイルの実体が無い写真は配信ルートが原寸へフォールバックする。
							src={`${entry.thumbUrls[0]}?v=${entry.updatedAt}`}
							alt={`${entry.name}の写真`}
							className="aspect-square w-full object-cover"
							// 画面外のカードは読み込まない(グリッドは1ページ24件)
							loading="lazy"
							decoding="async"
							width={400}
							height={400}
						/>
					) : (
						<div className="flex aspect-square w-full items-center justify-center bg-muted">
							<WineIcon
								className="size-10 text-muted-foreground/40"
								aria-hidden
							/>
						</div>
					)}
					<CardContent className="flex flex-col gap-1 p-3">
						<p className="line-clamp-2 text-sm font-medium">{entry.name}</p>
						{entry.lastRating !== null && (
							<RatingStars rating={entry.lastRating} />
						)}
						<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
							{entry.lastDrankOn && <span>{entry.lastDrankOn}</span>}
							{entry.tastingCount > 1 && (
								<span>{entry.tastingCount}回飲んだ</span>
							)}
							{provenance && <span>{provenance}</span>}
							<span>
								{[
									entry.vintage !== null ? `${entry.vintage}年` : undefined,
									entry.price !== null
										? `¥${entry.price.toLocaleString()}`
										: undefined,
								]
									.filter(Boolean)
									.join(" ・ ")}
							</span>
						</div>
					</CardContent>
				</Card>
			</Link>

			<span className="pointer-events-none absolute left-2 top-2 rounded-full bg-foreground/80 px-2 py-0.5 text-[10px] font-medium leading-none text-background">
				{WINE_STATUS_LABELS_JA[entry.status]}
			</span>

			{selectMode ? (
				<Checkbox
					checked={selected}
					onCheckedChange={() => onToggleSelect(entry.id)}
					aria-label={`${entry.name}を選択`}
					className="absolute right-2 top-2 size-5 border-foreground/40 bg-background"
				/>
			) : (
				entry.status === "owned" && (
					<Button
						type="button"
						size="sm"
						className="absolute bottom-2 right-2 h-7 px-2 text-xs"
						disabled={drink.isPending}
						onClick={() => drink.mutate()}
					>
						{drink.isPending ? "記録中…" : "飲んだ"}
					</Button>
				)
			)}
		</div>
	);
}

function CellarPage() {
	const { page, counts, wineListAnalysis, places } = Route.useLoaderData();
	const { filter, place } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();

	// 追加読み込みぶんを積む。loader が返す1ページ目が変わったら積み直す
	// (絞り込みの切り替え・保存後の invalidate)。複数選択削除(Issue #363 案B)の
	// 選択状態も同じタイミングで破棄する(見えていないエントリを選択済み扱いの
	// まま残さない)。
	const [extra, setExtra] = useState<DrunkWineEntry[]>([]);
	const [cursor, setCursor] = useState<string | null>(page.nextCursor);
	const [loadingMore, setLoadingMore] = useState(false);
	const [selectMode, setSelectMode] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	useEffect(() => {
		setExtra([]);
		setCursor(page.nextCursor);
		setSelectMode(false);
		setSelected(new Set());
	}, [page]);

	const visible = [...page.entries, ...extra];
	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		try {
			const next = await listDrunkWines({
				data: {
					filter,
					...(place ? { placeId: place } : {}),
					limit: DRUNK_WINE_PAGE_SIZE,
					cursor,
				},
			});
			setExtra((prev) => [...prev, ...next.entries]);
			setCursor(next.nextCursor);
		} finally {
			setLoadingMore(false);
		}
	};

	const toggleSelect = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	// 「すべて選択」は読み込み済みの全件を選ぶので、選択数は1リクエストの上限
	// (BULK_DELETE_MAX)を超えうる。超えた分は分割して順に送る(#400)。
	// 途中で失敗したら、そこまでの削除は確定したまま中断してエラーを出す。
	// そのまま「削除する」を押し直せば、消えた id は黙って無視されるので
	// (サービス層の仕様)残りだけが消える。
	const bulkDelete = useMutation({
		mutationFn: async () => {
			const ids = [...selected];
			for (let i = 0; i < ids.length; i += BULK_DELETE_MAX) {
				await deleteDrunkWines({
					data: { ids: ids.slice(i, i + BULK_DELETE_MAX) },
				});
			}
		},
		onSuccess: () => {
			setConfirmOpen(false);
			setSelectMode(false);
			setSelected(new Set());
			router.invalidate();
		},
		onError: (err: Error) => setDeleteError(err.message),
	});

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6 flex flex-wrap items-center gap-2">
				<h1 className="text-2xl font-bold">マイセラー</h1>
				<div className="ml-auto flex flex-wrap gap-2">
					{selectMode ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								setSelectMode(false);
								setSelected(new Set());
							}}
						>
							<XIcon className="size-4" aria-hidden />
							キャンセル
						</Button>
					) : (
						visible.length > 0 && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setSelectMode(true)}
							>
								<ListChecksIcon className="size-4" aria-hidden />
								選択
							</Button>
						)
					)}
					<Button asChild variant="outline" size="sm">
						<Link to="/cellar/map" search={{ filter }}>
							<MapIcon className="size-4" aria-hidden />
							地図で見る
						</Link>
					</Button>
					{wineListAnalysis.available && (
						<Button asChild variant="outline" size="sm">
							<Link to="/cellar/import">
								<ImagesIcon className="size-4" aria-hidden />
								写真からまとめて登録
							</Link>
						</Button>
					)}
					<Button asChild variant="outline" size="sm">
						<Link to="/cellar/import/history">
							<HistoryIcon className="size-4" aria-hidden />
							一括登録の履歴
						</Link>
					</Button>
					<Button asChild size="sm">
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							追加
						</Link>
					</Button>
				</div>
			</div>

			{selectMode && (
				<div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
					<span className="text-sm text-muted-foreground">
						{selected.size}件選択中
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() =>
							setSelected((prev) =>
								prev.size === visible.length
									? new Set()
									: new Set(visible.map((e) => e.id)),
							)
						}
					>
						{selected.size === visible.length ? "選択解除" : "すべて選択"}
					</Button>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						className="ml-auto"
						disabled={selected.size === 0}
						onClick={() => {
							setDeleteError("");
							setConfirmOpen(true);
						}}
					>
						<Trash2Icon className="size-4" aria-hidden />
						削除
					</Button>
				</div>
			)}

			{counts.all > 0 && (
				<div className="mb-4">
					<CellarFilterChips
						value={filter}
						counts={counts}
						onChange={(next) =>
							navigate({
								search: (prev) => ({ ...prev, filter: next }),
								replace: true,
							})
						}
					/>
				</div>
			)}

			{/*
			  場所の絞り込みは場所を1つ以上持っているときだけ出す。一括登録で店を
			  記録していないユーザには意味が無く、常設すると空のセレクタが並ぶ。
			*/}
			{places.length > 0 && (
				<div className="mb-4 flex items-center gap-2">
					<Label htmlFor="cellar-place" className="text-sm shrink-0">
						場所
					</Label>
					<Select
						value={place ?? ALL_PLACES}
						onValueChange={(next) =>
							navigate({
								search: (prev) => ({
									...prev,
									place: next === ALL_PLACES ? undefined : next,
								}),
								replace: true,
							})
						}
					>
						<SelectTrigger id="cellar-place" className="w-full max-w-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL_PLACES}>すべての場所</SelectItem>
							{places.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{/*
			  「1本も無い」の初回案内は、場所で絞っていないときだけ出す。場所を選んだ
			  結果0件なのに「まだ記録がありません」と出すと、記録が消えたように読める。
			*/}
			{counts.all === 0 && !place ? (
				<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-16">
					<WineIcon className="size-10 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ記録がありません。飲んだワインも、買っておいたボトルも記録できます。
					</p>
					<Button asChild>
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							ワインを記録する
						</Link>
					</Button>
				</div>
			) : visible.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
					この条件に該当するワインはありません。
				</p>
			) : (
				<>
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
						{visible.map((entry) => (
							<EntryCard
								key={entry.id}
								entry={entry}
								selectMode={selectMode}
								selected={selected.has(entry.id)}
								onToggleSelect={toggleSelect}
							/>
						))}
					</div>
					{cursor && (
						<div className="mt-6 flex justify-center">
							<Button
								type="button"
								variant="outline"
								onClick={() => void loadMore()}
								disabled={loadingMore}
							>
								{loadingMore ? "読み込み中…" : "続きを読み込む"}
							</Button>
						</div>
					)}
				</>
			)}

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{selected.size}件を削除しますか?</DialogTitle>
						<DialogDescription>
							選択した{selected.size}
							件の記録と写真を削除します。この操作は取り消せません。
						</DialogDescription>
					</DialogHeader>
					{deleteError && (
						<p className="text-sm text-destructive">{deleteError}</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={bulkDelete.isPending}
							onClick={() => setConfirmOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={bulkDelete.isPending}
							onClick={() => bulkDelete.mutate()}
						>
							{bulkDelete.isPending ? "削除中..." : "削除する"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}
