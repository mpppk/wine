import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	ListIcon,
	PencilIcon,
	PlusIcon,
	WineIcon,
	XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { AopMapView } from "#/components/wine/AopMapView";
import { MobileDetailSheet } from "#/components/wine/MobileDetailSheet";
import { useMapOverlayInset } from "#/components/wine/useMapOverlayInset";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { AOP_KINDS } from "#/lib/wine/map-style";
import { getAop, listAops, listRegions } from "#/lib/wine/service";
import { getSession } from "#/server/auth";
import { listDrunkWines } from "#/server/drunk-wine";

export const Route = createFileRoute("/cellar/map")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: () => listDrunkWines(),
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
								{entry.drankOn && <span>{entry.drankOn}</span>}
								{entry.rating !== null && <RatingStars rating={entry.rating} />}
							</div>
						</div>
						<Button
							asChild
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
						>
							<Link
								to="/cellar/$entryId/edit"
								params={{ entryId: entry.id }}
								aria-label={`${entry.name}を編集`}
							>
								<PencilIcon className="size-4" />
							</Link>
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}

function CellarMapPage() {
	const entries = Route.useLoaderData();

	// AOP紐付けありのエントリを地域別に集計(regionId は AOP紐付け時のみ非null)
	const linkedEntries = useMemo(
		() => entries.filter((e) => e.aopId !== null && e.regionId !== null),
		[entries],
	);
	const unlinkedCount = entries.length - linkedEntries.length;
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
	const presentKinds = useMemo(
		() => AOP_KINDS.filter((k) => aops.some((a) => a.kind === k)),
		[aops],
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

	return (
		<main className="flex h-[calc(100dvh-57px)] flex-col sm:h-[calc(100dvh-65px)]">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
				<PageHeader />
				<div className="ml-auto flex flex-wrap items-center gap-2">
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

			{unlinkedCount > 0 && (
				<p className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
					AOP未紐付けの記録が {unlinkedCount}{" "}
					件あります(地図には表示されません)。{" "}
					<Link to="/cellar" className="underline underline-offset-2">
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
						visibleKinds={presentKinds}
						highlightAopIds={highlightAopIds}
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

				{/* デスクトップ: 右サイドバー / モバイル: 下部オーバーレイ */}
				{selectedAop && selectedAopEntries.length > 0 && (
					<>
						<aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border lg:block">
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
