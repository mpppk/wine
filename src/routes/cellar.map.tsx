import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	ListIcon,
	PlusIcon,
	WineIcon,
	XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { CellarFilterChips } from "#/components/cellar/CellarFilterChips";
import { CellarStatusLegend } from "#/components/cellar/CellarStatusLegend";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { AopMapView } from "#/components/wine/AopMapView";
import { MobileDetailSheet } from "#/components/wine/MobileDetailSheet";
import { useMapOverlayInset } from "#/components/wine/useMapOverlayInset";
import {
	CELLAR_FILTER_IDS,
	countCellarFilters,
	DEFAULT_CELLAR_FILTER,
	matchesCellarFilter,
} from "#/lib/drunk-wine/filter";
import { buildAopStatusMap, hasMixedAopStatus } from "#/lib/drunk-wine/status";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { getAop, listAops, listRegions } from "#/lib/wine/service";
import { listDrunkWines } from "#/server/drunk-wine";

export const Route = createFileRoute("/cellar/map")({
	// 一覧(/cellar)と同じ絞り込み条件を URL で引き継ぐ(規約は cellar.index.tsx 参照)
	validateSearch: z.object({
		filter: z
			.enum(CELLAR_FILTER_IDS)
			.catch(DEFAULT_CELLAR_FILTER)
			.default(DEFAULT_CELLAR_FILTER),
	}),
	beforeLoad: requireAuthBeforeLoad,
	// 地図は全ピンを一度に描くのでページ単位にできない(全件取得のまま)。
	loader: async () => (await listDrunkWines()).entries,
	component: CellarMapPage,
});

// 選択AOPのワインミニリスト(このページ専用のローカルコンポーネント)
function AopWinePanel({
	aopNameJa,
	entries,
	onClose,
}: {
	aopNameJa: string;
	entries: DrunkWineEntry[];
	/** 未指定なら閉じるボタンを出さない(モバイルはシートのハンドルで閉じる) */
	onClose?: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 p-4">
			<div className="flex items-start justify-between gap-2">
				<h2 className="text-sm font-semibold">{aopNameJa}</h2>
				{onClose && (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="-mt-1.5 -mr-1.5 size-7"
						aria-label="閉じる"
						onClick={onClose}
					>
						<XIcon className="size-4" />
					</Button>
				)}
			</div>
			<ul className="flex flex-col divide-y divide-border">
				{entries.map((entry) => (
					<li key={entry.id} className="flex items-center gap-3 py-2">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm">{entry.name}</p>
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								{entry.lastDrankOn && <span>{entry.lastDrankOn}</span>}
								{entry.lastRating !== null && (
									<RatingStars rating={entry.lastRating} />
								)}
							</div>
						</div>
						<Button
							asChild
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
						>
							<Link
								to="/cellar/$entryId"
								params={{ entryId: entry.id }}
								aria-label={`${entry.name}の詳細`}
							>
								<ChevronRightIcon className="size-4" />
							</Link>
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

function CellarMapPage() {
	const allEntries = Route.useLoaderData();
	const { filter } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	const counts = useMemo(() => countCellarFilters(allEntries), [allEntries]);
	const entries = useMemo(
		() => allEntries.filter((e) => matchesCellarFilter(e, filter)),
		[allEntries, filter],
	);

	// AOP紐付けありのエントリを地域別に集計(AOP紐付け行は regionId が導出で非null)。
	// 絞り込み後の集合から作るので、highlightAopIds も件数バッジもフィルタに追従する。
	const linkedEntries = useMemo(
		() => entries.filter((e) => e.aopId !== null && e.regionId !== null),
		[entries],
	);
	// 地域・国単位の粗い紐付け。AOPを特定していないので地図には出せないが、
	// 「未紐付け」とは区別して案内する(編集でAOPまで絞れば地図に載る)。
	const coarseLinkedCount = useMemo(
		() =>
			entries.filter(
				(e) =>
					e.aopId === null && (e.regionId !== null || e.countryId !== null),
			).length,
		[entries],
	);
	const unlinkedCount =
		entries.length - linkedEntries.length - coarseLinkedCount;
	const countsByRegion = useMemo(() => {
		const m = new Map<string, number>();
		for (const e of linkedEntries) {
			if (e.regionId) m.set(e.regionId, (m.get(e.regionId) ?? 0) + 1);
		}
		return m;
	}, [linkedEntries]);

	const regions = useMemo(() => listRegions().filter((r) => r.enabled), []);
	const initialRegionId = useMemo(() => {
		let best: string | undefined;
		let bestCount = 0;
		for (const r of regions) {
			const count = countsByRegion.get(r.id) ?? 0;
			if (count > bestCount) {
				best = r.id;
				bestCount = count;
			}
		}
		return best;
	}, [regions, countsByRegion]);

	const [regionId, setRegionId] = useState<string | undefined>(initialRegionId);
	const [selectedAopId, setSelectedAopId] = useState<string | undefined>();

	const region = regions.find((r) => r.id === regionId);
	const aops = useMemo(
		() => (region ? listAops({ regionId: region.id }) : []),
		[region],
	);
	// 表示中の地域のエントリ。色分けと凡例の注記はどちらもここから導く。
	const regionEntries = useMemo(
		() => linkedEntries.filter((e) => e.regionId === regionId),
		[linkedEntries, regionId],
	);
	// AOPごとの代表状態(色分けの入力)。混在AOPの畳み方は buildAopStatusMap が
	// 単一情報源で、優先度は owned > wishlist > finished。
	const statusByAopId = useMemo(
		() => buildAopStatusMap(regionEntries),
		[regionEntries],
	);
	// 注記は実データに混在があるときだけ出す(絞り込みチップからは導けない。
	// "飲んだことがある" は所有状態と直交し、"飲んだ"(finished) のチップは無い)。
	const mixedStatus = useMemo(
		() => hasMixedAopStatus(regionEntries),
		[regionEntries],
	);

	const highlightAopIds = useMemo(() => {
		const s = new Set<string>();
		for (const e of linkedEntries) {
			if (e.regionId === regionId && e.aopId) s.add(e.aopId);
		}
		return s;
	}, [linkedEntries, regionId]);

	const selectedAop = selectedAopId ? getAop(selectedAopId) : undefined;
	const selectedAopEntries = useMemo(
		() =>
			selectedAopId
				? linkedEntries.filter((e) => e.aopId === selectedAopId)
				: [],
		[linkedEntries, selectedAopId],
	);

	// モバイルの下部パネルが覆う分を地図の中心合わせから除外する
	const { panelRef, getInset } = useMapOverlayInset();

	if (entries.length === 0) {
		return (
			<main className="mx-auto max-w-2xl px-4 py-10">
				<div className="mb-6">
					<PageHeader />
				</div>
				<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-16">
					<WineIcon className="size-10 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ記録がありません。飲んだワインを記録すると地図に色が付きます。
					</p>
					<Button asChild>
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							ワインを記録する
						</Link>
					</Button>
				</div>
			</main>
		);
	}

	// 高さの組み立ては map.$regionId と同じ(ヘッダ実測の --header-height を引き、
	// はみ出しは内側のスクロール領域に閉じ込めてドキュメントをスクロールさせない)。
	return (
		<main className="flex h-[calc(100dvh-var(--header-height,57px)-var(--ad-banner-height,0px))] flex-col overflow-hidden sm:h-[calc(100dvh-var(--header-height,65px)-var(--ad-banner-height,0px))]">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
				<PageHeader />
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<CellarFilterChips
						value={filter}
						counts={counts}
						onChange={(next) => {
							navigate({ search: { filter: next }, replace: true });
							setSelectedAopId(undefined);
						}}
					/>
					<fieldset
						className="flex flex-wrap items-center gap-1"
						aria-label="地域切替"
					>
						{regions.map((r) => {
							const count = countsByRegion.get(r.id) ?? 0;
							const active = r.id === regionId;
							return (
								<button
									key={r.id}
									type="button"
									disabled={count === 0}
									aria-pressed={active}
									onClick={() => {
										setRegionId(r.id);
										setSelectedAopId(undefined);
									}}
									className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
										active
											? "border-transparent bg-foreground text-background"
											: "border-border text-muted-foreground hover:border-foreground/40"
									}`}
								>
									{r.nameJa}
									<span
										className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium ${
											active
												? "bg-background/20"
												: "bg-muted text-muted-foreground"
										}`}
									>
										{count}
									</span>
								</button>
							);
						})}
					</fieldset>
				</div>
			</div>

			{(unlinkedCount > 0 || coarseLinkedCount > 0) && (
				<p className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
					{[
						unlinkedCount > 0 && `産地未紐付けのワインが ${unlinkedCount} 件`,
						coarseLinkedCount > 0 &&
							`地域・国まで紐付けたワインが ${coarseLinkedCount} 件`,
					]
						.filter(Boolean)
						.join("、")}
					あります(AOPを紐付けたワインだけが地図に表示されます)。{" "}
					<Link
						to="/cellar"
						search={{ filter }}
						className="underline underline-offset-2"
					>
						<ListIcon
							className="inline size-3.5 align-text-bottom"
							aria-hidden
						/>{" "}
						リストで見る
					</Link>
				</p>
			)}

			<div className="relative flex min-h-0 flex-1">
				{region ? (
					<AopMapView
						region={region}
						aops={aops}
						selectedAopId={selectedAopId}
						highlightAopIds={highlightAopIds}
						colorMode="status"
						statusByAopId={statusByAopId}
						onSelectAop={setSelectedAopId}
						getFitInset={getInset}
						className="min-w-0 flex-1"
					/>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-4">
						<p className="text-sm text-muted-foreground">
							AOPに紐付いた記録がまだありません。記録にAOPを紐付けると地図に色が付きます。
						</p>
						<Button asChild variant="outline">
							<Link to="/cellar">リストへ戻る</Link>
						</Button>
					</div>
				)}

				{region && (
					<CellarStatusLegend
						showMixedNote={mixedStatus}
						className="absolute bottom-3 left-3"
					/>
				)}

				{/* デスクトップ: 右サイドバー / モバイル: 下部オーバーレイ */}
				{selectedAop && selectedAopEntries.length > 0 && (
					<>
						{/* relative: 絶対配置の子孫(sr-only 等)がスクロールのクリップを
						    すり抜けてページのスクロール量になるのを防ぐ */}
						<aside className="relative hidden w-80 shrink-0 overflow-y-auto border-l border-border lg:block">
							<AopWinePanel
								aopNameJa={selectedAop.nameJa}
								entries={selectedAopEntries}
								onClose={() => setSelectedAopId(undefined)}
							/>
						</aside>
						<MobileDetailSheet
							panelRef={panelRef}
							onDismiss={() => setSelectedAopId(undefined)}
							className="absolute inset-x-2 bottom-2 lg:hidden"
						>
							<AopWinePanel
								aopNameJa={selectedAop.nameJa}
								entries={selectedAopEntries}
							/>
						</MobileDetailSheet>
					</>
				)}
			</div>
		</main>
	);
}

function PageHeader() {
	return (
		<div className="flex items-center gap-2">
			<Button asChild variant="ghost" size="icon" aria-label="マイセラーへ戻る">
				<Link to="/cellar">
					<ArrowLeftIcon className="size-4" />
				</Link>
			</Button>
			<h1 className="text-base font-semibold">飲んだAOPの地図</h1>
		</div>
	);
}
