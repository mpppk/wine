import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	GraduationCapIcon,
	ListIcon,
	LogInIcon,
	MapIcon,
	PaletteIcon,
	SproutIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { MapQuizDialog } from "#/components/quiz/MapQuizDialog";
import { Button } from "#/components/ui/button";
import { AopDetailPanel } from "#/components/wine/AopDetailPanel";
import { AopMapView } from "#/components/wine/AopMapView";
import { AopTreeList } from "#/components/wine/AopTreeList";
import { GrapeFilterSelect } from "#/components/wine/GrapeFilterSelect";
import { MobileDetailSheet } from "#/components/wine/MobileDetailSheet";
import { useAopKeyNav } from "#/components/wine/useAopKeyNav";
import { useMapOverlayInset } from "#/components/wine/useMapOverlayInset";
import { countScopedQuestions } from "#/lib/quiz/scope";
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
	PROGRESS_BUCKETS,
	PROGRESS_EMPTY_COLOR,
} from "#/lib/wine/map-style";
import { aopAllowsGrape, getRegion, listAops } from "#/lib/wine/service";
import { AOP_TAG_IDS, AOP_TAGS, type AopTagId } from "#/lib/wine/tags";
import { getAppellationTermJa } from "#/lib/wine/terminology";
import type { AopKind, RegionId } from "#/lib/wine/types";
import { getAffiliateConfig } from "#/server/affiliate";
import { getSession } from "#/server/auth";
import { getAopProgress } from "#/server/quiz";

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
	/** 色分けモード。省略時は区分(kind)。"progress"=クイズ学習済み率 */
	color: z.enum(["progress"]).optional(),
});

export const Route = createFileRoute("/map/$regionId")({
	validateSearch: searchSchema,
	// クイズは未ログインでも回答可・記録なし。SSR時点で確定するログイン状態を
	// context で下に渡す(quiz.play と同じパターン)
	beforeLoad: async () => {
		const session = await getSession();
		return { isAuthenticated: !!session };
	},
	loader: async ({ params, context }) => {
		const region = getRegion(params.regionId);
		if (!region?.enabled) {
			throw redirect({ to: "/regions" });
		}
		// 進捗色分け用のAOP別学習済み率はユーザ固有データ。未ログイン時は取得しない
		// (クライアントで全AOP「データなし」扱い + ログイン促し)
		const [affiliate, aopProgress] = await Promise.all([
			getAffiliateConfig(),
			context.isAuthenticated
				? getAopProgress({ data: { regionId: region.id as RegionId } })
				: Promise.resolve(null),
		]);
		return {
			region,
			aops: listAops({ regionId: region.id }),
			affiliate,
			aopProgress,
		};
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
	const { region, aops, affiliate, aopProgress } = Route.useLoaderData();
	const {
		grape,
		aop: selectedAopId,
		cls,
		tags,
		view,
		color,
	} = Route.useSearch();
	const { isAuthenticated } = Route.useRouteContext();
	const navigate = useNavigate({ from: Route.fullPath });
	const isListView = view === "list";
	const colorMode = color === "progress" ? "progress" : "kind";

	// 進捗レスポンス(AOP slug -> 率)を地図のjoinキー idApp -> 率 に変換
	const progressByIdApp = useMemo(() => {
		const m = new Map<number, number>();
		if (aopProgress) {
			for (const a of aops) {
				const rate = aopProgress.byAopId[a.id];
				if (rate !== undefined) m.set(a.idApp, rate);
			}
		}
		return m;
	}, [aopProgress, aops]);

	// クイズモーダルの開閉と出題スコープ。セッションはエフェメラル(閉じたら破棄)
	// なのでURLには載せない。開いた時点のAOPをスナップショットするため、
	// モーダル表示中に選択が変わってもスコープは保持される
	const [quizScope, setQuizScope] = useState<
		{ kind: "region" } | { kind: "aop"; aopId: string } | null
	>(null);

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
	const selectedAopQuizCount = useMemo(
		() =>
			selectedAop
				? countScopedQuestions(region.id as RegionId, selectedAop.id)
				: 0,
		[selectedAop, region.id],
	);
	const startAopQuiz = selectedAop
		? () => setQuizScope({ kind: "aop", aopId: selectedAop.id })
		: undefined;

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
		color?: "progress" | undefined;
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

	// モバイルの下部詳細パネルが覆う分を地図の中心合わせから除外する
	const { panelRef, getInset } = useMapOverlayInset();

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
		<main className="flex h-[calc(100dvh-57px-var(--ad-banner-height,0px))] flex-col sm:h-[calc(100dvh-65px-var(--ad-banner-height,0px))]">
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
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setQuizScope({ kind: "region" })}
					>
						<GraduationCapIcon className="size-4" aria-hidden />
						クイズ
					</Button>

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

					{!isListView && (
						<fieldset
							className="flex items-center rounded-md border border-border p-0.5"
							aria-label="色分けモード"
						>
							<button
								type="button"
								onClick={() => setSearch({ color: undefined })}
								aria-pressed={colorMode === "kind"}
								className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
									colorMode === "kind"
										? "bg-muted font-medium"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								<PaletteIcon className="size-3.5" aria-hidden />
								区分
							</button>
							<button
								type="button"
								onClick={() => setSearch({ color: "progress" })}
								aria-pressed={colorMode === "progress"}
								className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
									colorMode === "progress"
										? "bg-muted font-medium"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								<SproutIcon className="size-3.5" aria-hidden />
								進捗
							</button>
						</fieldset>
					)}

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
						colorMode={colorMode}
						progressByIdApp={progressByIdApp}
						onSelectAop={(id) => setSearch({ aop: id })}
						getFitInset={getInset}
						className="min-w-0 flex-1"
					/>
				)}

				{/* 進捗モードの凡例・未ログイン促し(地図表示時のみ) */}
				{!isListView && colorMode === "progress" && (
					<>
						<div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
							<div className="mb-1 font-medium">クイズ学習済み率</div>
							<div className="flex items-center gap-1.5">
								<span className="text-muted-foreground">少</span>
								<span
									className="inline-block size-3.5 rounded-sm"
									style={{ backgroundColor: PROGRESS_EMPTY_COLOR.fill }}
									title="未学習"
								/>
								{PROGRESS_BUCKETS.map((b) => (
									<span
										key={b.fill}
										className="inline-block size-3.5 rounded-sm"
										style={{ backgroundColor: b.fill }}
									/>
								))}
								<span className="text-muted-foreground">多</span>
							</div>
						</div>
						{!isAuthenticated && (
							<div className="absolute inset-x-0 top-3 z-10 flex justify-center px-3">
								<div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
									<span className="text-muted-foreground">
										ログインすると学習の進捗が地図に表示されます
									</span>
									<Button asChild size="sm" variant="secondary">
										<Link to="/login">
											<LogInIcon className="size-3.5" aria-hidden />
											ログイン
										</Link>
									</Button>
								</div>
							</div>
						)}
					</>
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
									quizQuestionCount={selectedAopQuizCount}
									onStartQuiz={startAopQuiz}
									affiliate={affiliate}
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

				{/* モバイル: 詳細を下部オーバーレイで表示。ハンドルを下スワイプで閉じる */}
				{selectedAop && (
					<MobileDetailSheet
						panelRef={panelRef}
						onDismiss={() => setSearch({ aop: undefined })}
						className="absolute inset-x-2 bottom-2 lg:hidden"
					>
						<AopDetailPanel
							aop={selectedAop}
							ancestry={selectedAncestry}
							onSelectAop={(id) => setSearch({ aop: id })}
							onPrev={goPrev}
							onNext={goNext}
							position={siblings}
							quizQuestionCount={selectedAopQuizCount}
							onStartQuiz={startAopQuiz}
							affiliate={affiliate}
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
					</MobileDetailSheet>
				)}
			</div>

			<MapQuizDialog
				open={quizScope !== null}
				onOpenChange={(open) => {
					if (!open) setQuizScope(null);
				}}
				regionId={region.id as RegionId}
				regionNameJa={region.nameJa}
				scopeAop={
					quizScope?.kind === "aop"
						? aops.find((a) => a.id === quizScope.aopId)
						: undefined
				}
				isAuthenticated={isAuthenticated}
			/>
		</main>
	);
}
