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
import { useAopKeyNav } from "#/components/wine/useAopKeyNav";
import {
	buildAopTree,
	flattenAopTree,
	getAopAncestry,
	getSameKindSiblings,
} from "#/lib/wine/aop-tree";
import {
	AOP_KINDS,
	GRAND_CRU_TAG_COLOR,
	KIND_COLORS,
	KIND_LABELS_JA,
} from "#/lib/wine/map-style";
import { aopAllowsGrape, getRegion, listAops } from "#/lib/wine/service";
import { AOP_TAG_IDS, AOP_TAGS, type AopTagId } from "#/lib/wine/tags";
import { getAppellationTermJa } from "#/lib/wine/terminology";
import type { AopKind } from "#/lib/wine/types";

const searchSchema = z.object({
	/** ブドウ品種フィルタ(variety id) */
	grape: z.string().optional(),
	/** 選択中のAOP(slug) */
	aop: z.string().optional(),
	/** 表示する区分(カンマ区切り)。省略時は全区分 */
	cls: z.string().optional(),
	/** 表示するタグ(カンマ区切り)。省略時はタグで絞り込まない */
	tags: z.string().optional(),
	/** 表示モード。省略時は地図 */
	view: z.enum(["list"]).optional(),
});

export const Route = createFileRoute("/map/$regionId")({
	validateSearch: searchSchema,
	loader: ({ params }) => {
		const region = getRegion(params.regionId);
		if (!region?.enabled) {
			throw redirect({ to: "/regions" });
		}
		return { region, aops: listAops({ regionId: region.id }) };
	},
	component: MapPage,
});

// 不正値(旧 "grand-cru" を含む)や地域に存在しない区分は捨て、
// 有効値が無ければ全区分(=その地域に実在する区分)へフォールバック
function parseKinds(
	cls: string | undefined,
	presentKinds: AopKind[],
): AopKind[] {
	if (!cls) return presentKinds;
	const parts = cls.split(",");
	const valid = presentKinds.filter((k) => parts.includes(k));
	return valid.length > 0 ? valid : presentKinds;
}

// タグは区分と違い「無選択=絞り込みなし」なので、空でもフォールバックしない
function parseTags(tags: string | undefined): AopTagId[] {
	if (!tags) return [];
	const parts = tags.split(",");
	return AOP_TAG_IDS.filter((t) => parts.includes(t));
}

function MapPage() {
	const { region, aops } = Route.useLoaderData();
	const { grape, aop: selectedAopId, cls, tags, view } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const isListView = view === "list";

	// この地域に実在する区分・タグだけをチップとして出す(winery等のデータ0件の
	// 区分や、タグを持つAOPが無い地域のタグ行を出さない)
	const presentKinds = useMemo(
		() => AOP_KINDS.filter((k) => aops.some((a) => a.kind === k)),
		[aops],
	);
	const presentTags = useMemo(
		() => AOP_TAGS.filter((t) => aops.some((a) => a.tags?.includes(t.id))),
		[aops],
	);

	const visibleKinds = useMemo(
		() => parseKinds(cls, presentKinds),
		[cls, presentKinds],
	);
	const visibleTags = useMemo(() => parseTags(tags), [tags]);
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
							visibleKinds.includes(a.kind) &&
							(visibleTags.length === 0 ||
								a.tags?.some((t) => visibleTags.includes(t))) &&
							(!grape || aopAllowsGrape(a, grape)),
					)
					.map((a) => a.id),
			),
		[aops, visibleKinds, visibleTags, grape],
	);

	const setSearch = (patch: {
		grape?: string | undefined;
		aop?: string | undefined;
		cls?: string | undefined;
		tags?: string | undefined;
		view?: "list" | undefined;
	}) => {
		void navigate({
			search: (prev) => ({ ...prev, ...patch }),
			replace: true,
		});
	};

	// 前後移動: リスト表示と同じ並び順をフラット化し、同一区分かつ表示中(フィルタ通過)の
	// AOPだけを対象に前後のidを求める。地図のパン/ズームは選択変更に追従して自動で行われる。
	const orderedAops = useMemo(
		() => flattenAopTree(buildAopTree(aops, region.subregions)),
		[aops, region.subregions],
	);
	const siblings = useMemo(
		() =>
			selectedAop
				? getSameKindSiblings(orderedAops, selectedAop, visibleAopIds)
				: undefined,
		[orderedAops, selectedAop, visibleAopIds],
	);
	const goPrev =
		siblings?.prevId !== undefined
			? () => setSearch({ aop: siblings.prevId })
			: undefined;
	const goNext =
		siblings?.nextId !== undefined
			? () => setSearch({ aop: siblings.nextId })
			: undefined;
	useAopKeyNav({ onPrev: goPrev, onNext: goNext, enabled: !!selectedAop });

	const toggleKind = (k: AopKind) => {
		const next = visibleKinds.includes(k)
			? visibleKinds.filter((x) => x !== k)
			: [...visibleKinds, k];
		// 全部OFFは意味がないので、その場合は全表示へ戻す
		setSearch({
			cls:
				next.length === 0 || next.length === presentKinds.length
					? undefined
					: next.join(","),
		});
	};

	const toggleTag = (t: AopTagId) => {
		const next = visibleTags.includes(t)
			? visibleTags.filter((x) => x !== t)
			: [...visibleTags, t];
		// タグは「無選択=絞り込みなし」。全選択でも無選択より狭い集合なので畳まない
		setSearch({ tags: next.length === 0 ? undefined : next.join(",") });
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
							{region.nameLocal} ・ {visibleAopIds.size}{" "}
							{getAppellationTermJa(region.id)}
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
						aria-label="区分フィルタ"
					>
						{presentKinds.map((k) => {
							const active = visibleKinds.includes(k);
							return (
								<button
									key={k}
									type="button"
									onClick={() => toggleKind(k)}
									aria-pressed={active}
									className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
										active
											? "border-transparent text-white"
											: "border-border text-muted-foreground hover:border-foreground/40"
									}`}
									style={
										active
											? { backgroundColor: KIND_COLORS[k].fill }
											: undefined
									}
								>
									{KIND_LABELS_JA[k]}
								</button>
							);
						})}
					</fieldset>

					{presentTags.length > 0 && (
						<fieldset
							className="flex items-center gap-1"
							aria-label="タグフィルタ"
						>
							{presentTags.map((tag) => {
								const active = visibleTags.includes(tag.id);
								return (
									<button
										key={tag.id}
										type="button"
										onClick={() => toggleTag(tag.id)}
										aria-pressed={active}
										className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
											active
												? "border-transparent bg-foreground text-background"
												: "border-border border-dashed text-muted-foreground hover:border-foreground/40"
										}`}
										style={
											active && tag.id === "grand-cru"
												? {
														backgroundColor: GRAND_CRU_TAG_COLOR.fill,
														color: "#fff",
													}
												: undefined
										}
									>
										{tag.labelJa}
									</button>
								);
							})}
						</fieldset>
					)}

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
						visibleKinds={visibleKinds}
						visibleTags={visibleTags}
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
									onPrev={goPrev}
									onNext={goNext}
									position={siblings}
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
							onPrev={goPrev}
							onNext={goNext}
							position={siblings}
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
