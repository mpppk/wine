import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { ArrowLeftIcon, ListIcon, MapIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { AopDetailPanel } from "#/components/wine/AopDetailPanel";
import { AopMapView } from "#/components/wine/AopMapView";
import { AopTreeList } from "#/components/wine/AopTreeList";
import { GrapeFilterSelect } from "#/components/wine/GrapeFilterSelect";
import { getAopAncestry } from "#/lib/wine/aop-tree";
import {
	CLASSIFICATION_COLORS,
	CLASSIFICATION_LABELS_JA,
	CLASSIFICATIONS,
} from "#/lib/wine/map-style";
import { aopAllowsGrape, getRegion, listAops } from "#/lib/wine/service";
import type { Classification } from "#/lib/wine/types";
import { getSession } from "#/server/auth";

const searchSchema = z.object({
	/** ブドウ品種フィルタ(variety id) */
	grape: z.string().optional(),
	/** 選択中のAOP(slug) */
	aop: z.string().optional(),
	/** 表示する格付け(カンマ区切り)。省略時は全格付け */
	cls: z.string().optional(),
	/** 表示モード。省略時は地図 */
	view: z.enum(["list"]).optional(),
});

export const Route = createFileRoute("/map/$regionId")({
	validateSearch: searchSchema,
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: ({ params }) => {
		const region = getRegion(params.regionId);
		if (!region?.enabled) {
			throw redirect({ to: "/regions" });
		}
		return { region, aops: listAops({ regionId: region.id }) };
	},
	component: MapPage,
});

function parseClassifications(cls: string | undefined): Classification[] {
	if (!cls) return CLASSIFICATIONS;
	const parts = cls.split(",");
	const valid = CLASSIFICATIONS.filter((c) => parts.includes(c));
	return valid.length > 0 ? valid : CLASSIFICATIONS;
}

function MapPage() {
	const { region, aops } = Route.useLoaderData();
	const { grape, aop: selectedAopId, cls, view } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const isListView = view === "list";

	const visibleClassifications = useMemo(
		() => parseClassifications(cls),
		[cls],
	);
	const selectedAop = aops.find((a) => a.id === selectedAopId);
	const selectedAncestry = useMemo(
		() => (selectedAop ? getAopAncestry(selectedAop, aops, region) : undefined),
		[selectedAop, aops, region],
	);

	// 一覧(サイドバー/リスト表示): 地図と同じフィルタを反映する
	const visibleAopIds = useMemo(
		() =>
			new Set(
				aops
					.filter(
						(a) =>
							visibleClassifications.includes(a.classification) &&
							(!grape || aopAllowsGrape(a, grape)),
					)
					.map((a) => a.id),
			),
		[aops, visibleClassifications, grape],
	);

	const setSearch = (patch: {
		grape?: string | undefined;
		aop?: string | undefined;
		cls?: string | undefined;
		view?: "list" | undefined;
	}) => {
		void navigate({
			search: (prev) => ({ ...prev, ...patch }),
			replace: true,
		});
	};

	const toggleClassification = (c: Classification) => {
		const next = visibleClassifications.includes(c)
			? visibleClassifications.filter((x) => x !== c)
			: [...visibleClassifications, c];
		// 全部OFFは意味がないので、その場合は全表示へ戻す
		setSearch({
			cls:
				next.length === 0 || next.length === CLASSIFICATIONS.length
					? undefined
					: next.join(","),
		});
	};

	const treeList = (
		<AopTreeList
			aops={aops}
			subregions={region.subregions}
			visibleAopIds={visibleAopIds}
			selectedAopId={selectedAopId}
			onSelect={(id) => setSearch({ aop: id })}
		/>
	);

	return (
		<main className="flex h-[calc(100dvh-57px)] flex-col sm:h-[calc(100dvh-65px)]">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
				<div className="flex items-center gap-2">
					<Button
						asChild
						variant="ghost"
						size="icon"
						aria-label="地域選択へ戻る"
					>
						<Link to="/regions">
							<ArrowLeftIcon className="size-4" />
						</Link>
					</Button>
					<h1 className="text-base font-semibold">
						{region.nameJa}
						<span className="ml-2 hidden text-sm font-normal text-muted-foreground sm:inline">
							{region.nameLocal} ・ {visibleAopIds.size} AOP
						</span>
					</h1>
				</div>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					<fieldset
						className="flex items-center rounded-md border border-border p-0.5"
						aria-label="表示モード"
					>
						<button
							type="button"
							onClick={() => setSearch({ view: undefined })}
							aria-pressed={!isListView}
							className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
								isListView
									? "text-muted-foreground hover:text-foreground"
									: "bg-muted font-medium"
							}`}
						>
							<MapIcon className="size-3.5" aria-hidden />
							地図
						</button>
						<button
							type="button"
							onClick={() => setSearch({ view: "list" })}
							aria-pressed={isListView}
							className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
								isListView
									? "bg-muted font-medium"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							<ListIcon className="size-3.5" aria-hidden />
							リスト
						</button>
					</fieldset>

					<fieldset
						className="flex items-center gap-1"
						aria-label="格付けフィルタ"
					>
						{CLASSIFICATIONS.map((c) => {
							const active = visibleClassifications.includes(c);
							return (
								<button
									key={c}
									type="button"
									onClick={() => toggleClassification(c)}
									aria-pressed={active}
									className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
										active
											? "border-transparent text-white"
											: "border-border text-muted-foreground hover:border-foreground/40"
									}`}
									style={
										active
											? { backgroundColor: CLASSIFICATION_COLORS[c].fill }
											: undefined
									}
								>
									{CLASSIFICATION_LABELS_JA[c]}
								</button>
							);
						})}
					</fieldset>

					<GrapeFilterSelect
						value={grape}
						onChange={(v) => setSearch({ grape: v })}
					/>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1">
				{isListView ? (
					<div className="min-w-0 flex-1 overflow-y-auto">
						<div className="mx-auto max-w-2xl">{treeList}</div>
					</div>
				) : (
					<AopMapView
						region={region}
						aops={aops}
						selectedAopId={selectedAopId}
						grapeVarietyId={grape}
						visibleClassifications={visibleClassifications}
						onSelectAop={(id) => setSearch({ aop: id })}
						className="min-w-0 flex-1"
					/>
				)}

				{/* デスクトップ: 右サイドバー(リスト表示時は詳細のみ、地図表示時は一覧 or 詳細) */}
				{(selectedAop || !isListView) && (
					<aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border lg:block">
						{selectedAop ? (
							<>
								<AopDetailPanel
									aop={selectedAop}
									ancestry={selectedAncestry}
									onSelectAop={(id) => setSearch({ aop: id })}
									onClose={() => setSearch({ aop: undefined })}
								/>
								{isListView && (
									<div className="px-4 pb-4">
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setSearch({ view: undefined })}
										>
											<MapIcon className="size-4" aria-hidden />
											地図で表示
										</Button>
									</div>
								)}
							</>
						) : (
							treeList
						)}
					</aside>
				)}

				{/* モバイル: 詳細を下部オーバーレイで表示 */}
				{selectedAop && (
					<div className="absolute inset-x-2 bottom-2 max-h-[55%] overflow-y-auto rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur lg:hidden">
						<AopDetailPanel
							aop={selectedAop}
							ancestry={selectedAncestry}
							onSelectAop={(id) => setSearch({ aop: id })}
							onClose={() => setSearch({ aop: undefined })}
						/>
						{isListView && (
							<div className="px-4 pb-4">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setSearch({ view: undefined })}
								>
									<MapIcon className="size-4" aria-hidden />
									地図で表示
								</Button>
							</div>
						)}
					</div>
				)}
			</div>
		</main>
	);
}
