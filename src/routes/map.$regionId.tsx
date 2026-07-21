import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	ChevronDownIcon,
	FunnelIcon,
	GraduationCapIcon,
	ListIcon,
	LogInIcon,
	MapIcon,
	PaletteIcon,
	SparklesIcon,
	SproutIcon,
} from "lucide-react";
import { type ComponentProps, useMemo, useState } from "react";
import { z } from "zod";
import { RegionChatDialog } from "#/components/ai/RegionChatDialog";
import { MapQuizDialog } from "#/components/quiz/MapQuizDialog";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { AopDetailPanel } from "#/components/wine/AopDetailPanel";
import { AopMapView } from "#/components/wine/AopMapView";
import { AopReferenceLinks } from "#/components/wine/AopReferenceLinks";
import { AopTreeList } from "#/components/wine/AopTreeList";
import { GrapeFilterMenu } from "#/components/wine/GrapeFilterMenu";
import { MobileDetailSheet } from "#/components/wine/MobileDetailSheet";
import { useAopKeyNav } from "#/components/wine/useAopKeyNav";
import { useMapOverlayInset } from "#/components/wine/useMapOverlayInset";
import { countScopedQuestions, expandScopeAopIds } from "#/lib/quiz/scope";
import {
	aopToken,
	buildKindFacets,
	facetLabelJa,
	facetToken,
	groupFacets,
	groupTokens,
	type KindFacets,
	kindToken,
} from "#/lib/wine/aop-filter";
import {
	buildAopTree,
	flattenAopTree,
	getAopAncestry,
	getSameKindSiblings,
} from "#/lib/wine/aop-tree";
import {
	AOP_KINDS,
	KIND_COLORS,
	KIND_LABELS_JA,
	PROGRESS_BUCKETS,
	PROGRESS_EMPTY_COLOR,
} from "#/lib/wine/map-style";
import { REGIONS } from "#/lib/wine/regions";
import { aopAllowsGrape, getRegion, listAops } from "#/lib/wine/service";
import {
	getAppellationTermJa,
	getVineyardTermJa,
} from "#/lib/wine/terminology";
import type { Aop, AopKind } from "#/lib/wine/types";
import { getAffiliateConfig } from "#/server/affiliate";
import { getSession } from "#/server/auth";
import { getAopProgress } from "#/server/quiz";

const searchSchema = z.object({
	/** ブドウ品種フィルタ(variety id) */
	grape: z.string().optional(),
	/** 選択中のAOP(slug) */
	aop: z.string().optional(),
	/**
	 * 非表示にするフィルタトークン(カンマ区切り)。省略時は全表示。
	 * 単純トグル区分は区分ID(例 "village")、マルチセレクト区分は "区分:facet"
	 * (例 "vineyard:grand-cru" / "village:__none__")。
	 */
	hide: z.string().optional(),
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
	loader: async ({ params }) => {
		const region = getRegion(params.regionId);
		if (!region?.enabled) {
			throw redirect({ to: "/regions" });
		}
		// 進捗表示用のAOP別正解進捗(solved/total)。total は静的データ由来なので
		// 未ログインでも取得できる(solved=0)。行の分母表示・ログイン促しに使う。
		const [affiliate, aopProgress] = await Promise.all([
			getAffiliateConfig(),
			getAopProgress({ data: { regionId: region.id } }),
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

// URL の hide を、その地域に実在するトークンだけに絞って集合化する。
// 未知トークン(地域に存在しない区分・古いURL 等)は捨て、既定=全表示へ寄せる。
function parseHide(
	hide: string | undefined,
	validTokens: ReadonlySet<string>,
): Set<string> {
	if (!hide) return new Set();
	return new Set(hide.split(",").filter((t) => validTokens.has(t)));
}

// 選択中AOPの詳細パネル + リスト表示時の「地図で表示」ボタン。デスクトップの
// 右サイドバーとモバイルの下部オーバーレイで同一の描画をするため、両者の重複
// (AopDetailPanel への十数個の props 受け渡し + ボタン)を1箇所に集約する。
// onClose はデスクトップのみ渡す(モバイルはシート側のハンドルで閉じる)。
function SelectedAopPanel({
	isListView,
	onShowMap,
	...panelProps
}: ComponentProps<typeof AopDetailPanel> & {
	isListView: boolean;
	onShowMap: () => void;
}) {
	return (
		<>
			<AopDetailPanel {...panelProps} />
			{isListView && (
				<div className="px-4 pb-4">
					<Button type="button" variant="outline" size="sm" onClick={onShowMap}>
						<MapIcon className="size-4" aria-hidden />
						地図で表示
					</Button>
				</div>
			)}
		</>
	);
}

function MapPage() {
	const { region, aops, affiliate, aopProgress } = Route.useLoaderData();
	const { grape, aop: selectedAopId, hide, view, color } = Route.useSearch();
	const { isAuthenticated } = Route.useRouteContext();
	const navigate = useNavigate({ from: Route.fullPath });
	const isListView = view === "list";
	const colorMode = color === "progress" ? "progress" : "kind";

	// AOP(slug)単位の「自身+階層近傍」の正解進捗。詳細パネルの「関連クイズ数」
	// (countScopedQuestions)と同じスコープで、リストの各行の分母をパネルと一致させる。
	// per-subject の進捗を expandScopeAopIds のスコープ集合で合算する
	// (スコープ内AOP同士の候補問題は主語で排他なので、単純合算で問題数と一致する)。
	const scopedProgressByAopId = useMemo(() => {
		const out: Record<string, { solved: number; total: number }> = {};
		if (!aopProgress) return out;
		for (const a of aops) {
			const scope = expandScopeAopIds(a.id);
			if (!scope) continue;
			let solved = 0;
			let total = 0;
			for (const s of scope) {
				const p = aopProgress.byAopId[s];
				if (p) {
					solved += p.solved;
					total += p.total;
				}
			}
			if (total > 0) out[a.id] = { solved, total };
		}
		return out;
	}, [aopProgress, aops]);

	// 地図の色分けは各ポリゴン=そのAOP自身の正解率(空間ヒートマップとしての意味を保つ
	// ため近傍は混ぜない)。per-subject の進捗を joinキー idApp -> 正解率 に変換。
	// 正解が1問も無い(solved=0)AOPは載せず、地図側で「未学習」色に沈める。
	const progressByIdApp = useMemo(() => {
		const m = new Map<number, number>();
		if (aopProgress) {
			for (const a of aops) {
				const p = aopProgress.byAopId[a.id];
				if (p && p.total > 0 && p.solved > 0) {
					m.set(a.idApp, Math.min(1, p.solved / p.total));
				}
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

	// 地域チャットQ&A(AIクレジット消費)の開閉。会話履歴はダイアログ側で保持する。
	const [chatOpen, setChatOpen] = useState(false);

	// 説明文/所属リンクで別AOPへ掘り下げた履歴。末尾が直前に見ていたAOP。
	// 地図クリック・ツリー選択・前後移動など「新規閲覧」ではリセットする。
	const [backStack, setBackStack] = useState<string[]>([]);

	// この地域に実在する区分だけをチップとして出す(winery等のデータ0件の区分を出さない)。
	// 格付けタグを2つ以上持つ区分はマルチセレクト化し、格付けを区分の下位に畳み込む。
	const presentKinds = useMemo(
		() => AOP_KINDS.filter((k) => aops.some((a) => a.kind === k)),
		[aops],
	);
	const kindFacets = useMemo(
		() => buildKindFacets(aops, presentKinds),
		[aops, presentKinds],
	);
	const facetsByKind = useMemo(
		() => new Map(kindFacets.map((kf) => [kf.kind, kf])),
		[kindFacets],
	);
	// 既定=全表示の判定・URL 整形に使う、全フィルタトークンの基準順リスト
	const allTokens = useMemo(
		() => kindFacets.flatMap((kf) => groupTokens(kf)),
		[kindFacets],
	);
	const validTokens = useMemo(() => new Set(allTokens), [allTokens]);
	const hideSet = useMemo(
		() => parseHide(hide, validTokens),
		[hide, validTokens],
	);
	// AOP -> 属するフィルタトークン。非表示判定に使う
	const tokenOf = useMemo(
		() => (a: Aop) => aopToken(a, facetsByKind),
		[facetsByKind],
	);
	// 区分・格付けフィルタで非表示になるAOP(品種フィルタは含めない: 地図では灰色に沈める)
	const hiddenAopIds = useMemo(
		() => new Set(aops.filter((a) => hideSet.has(tokenOf(a))).map((a) => a.id)),
		[aops, hideSet, tokenOf],
	);

	const selectedAop = aops.find((a) => a.id === selectedAopId);
	const selectedAncestry = useMemo(
		() => (selectedAop ? getAopAncestry(selectedAop, aops, region) : undefined),
		[selectedAop, aops, region],
	);
	const selectedAopQuizCount = useMemo(
		() => (selectedAop ? countScopedQuestions(region.id, selectedAop.id) : 0),
		[selectedAop, region.id],
	);
	const startAopQuiz = selectedAop
		? () => setQuizScope({ kind: "aop", aopId: selectedAop.id })
		: undefined;

	// 参考リンク欄(ユーザ固有・要ログイン)。デスクトップ/モバイル両パネルに同じ内容を
	// 差し込む。未ログイン時はコンポーネント側でログイン導線のみ表示する。
	const referenceLinksSlot = selectedAop ? (
		<AopReferenceLinks
			aopId={selectedAop.id}
			isAuthenticated={isAuthenticated}
		/>
	) : undefined;

	// 一覧(サイドバー/リスト表示): 地図と同じ絞り込みを反映する。リストでは品種
	// 不一致も非表示にする(地図は灰色に沈めるだけなので hiddenAopIds とは別に組む)
	const visibleAopIds = useMemo(
		() =>
			new Set(
				aops
					.filter(
						(a) =>
							!hideSet.has(tokenOf(a)) && (!grape || aopAllowsGrape(a, grape)),
					)
					.map((a) => a.id),
			),
		[aops, hideSet, tokenOf, grape],
	);

	const setSearch = (patch: {
		grape?: string | undefined;
		aop?: string | undefined;
		hide?: string | undefined;
		view?: "list" | undefined;
		color?: "progress" | undefined;
	}) => {
		void navigate({
			search: (prev) => ({ ...prev, ...patch }),
			replace: true,
		});
	};

	// 地図クリック・ツリー選択など「新規閲覧」。掘り下げ履歴をリセットして選択する。
	const selectFresh = (id: string | undefined) => {
		setBackStack([]);
		setSearch({ aop: id });
	};
	// パネル内の説明文/所属リンク経由の遷移。今見ているAOPを履歴に積んでから移動する。
	const navigateRelated = (id: string) => {
		if (selectedAopId) setBackStack((s) => [...s, selectedAopId]);
		setSearch({ aop: id });
	};
	// 地図クリックでの選択。パネルを開いたまま別AOPを選び直したときは、直前のAOPを
	// 履歴に積んで「戻る」を出す(パネル内リンク遷移と同じ挙動)。空白クリックでの選択解除や
	// 同一AOPの再クリックは selectFresh(履歴リセット)に委ねる。
	const selectFromMap = (id: string | undefined) => {
		if (
			id !== undefined &&
			selectedAopId !== undefined &&
			id !== selectedAopId
		) {
			navigateRelated(id);
		} else {
			selectFresh(id);
		}
	};
	// 直前に見ていたAOPへ戻る。履歴があるときだけ有効。
	const backToId = backStack.at(-1);
	const goBack = backToId
		? () => {
				setBackStack((s) => s.slice(0, -1));
				setSearch({ aop: backToId });
			}
		: undefined;
	const backToName = backToId
		? aops.find((a) => a.id === backToId)?.nameJa
		: undefined;
	// 説明文中の地域名リンク。別地域の地図へ遷移する(ブラウザ履歴で戻れる)。
	const selectRegion = (regionId: string) => {
		void navigate({ to: "/map/$regionId", params: { regionId } });
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
			? () => selectFresh(siblings.prevId)
			: undefined;
	const goNext =
		siblings?.nextId !== undefined
			? () => selectFresh(siblings.nextId)
			: undefined;
	useAopKeyNav({ onPrev: goPrev, onNext: goNext, enabled: !!selectedAop });

	// モバイルの下部詳細パネルが覆う分を地図の中心合わせから除外する
	const { panelRef, getInset } = useMapOverlayInset();

	// hide 集合を URL に書き戻す。既定(何も非表示でない)は省略してURLを短く保つ。
	const writeHide = (next: Set<string>) => {
		const ordered = allTokens.filter((t) => next.has(t));
		setSearch({ hide: ordered.length === 0 ? undefined : ordered.join(",") });
	};

	// トークンの表示/非表示をトグルする(単純トグル区分・マルチセレクトの facet 共通)
	const toggleToken = (token: string) => {
		const next = new Set(hideSet);
		if (next.has(token)) next.delete(token);
		else next.add(token);
		writeHide(next);
	};

	const treeList = (
		<AopTreeList
			aops={aops}
			subregions={region.subregions}
			visibleAopIds={visibleAopIds}
			selectedAopId={selectedAopId}
			onSelect={selectFresh}
			colorMode={colorMode}
			progressByAopId={aopProgress?.byAopId}
			rowProgressByAopId={scopedProgressByAopId}
			isAuthenticated={isAuthenticated}
			getScrollInset={getInset}
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

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setChatOpen(true)}
					>
						<SparklesIcon className="size-4" aria-hidden />
						AIに質問
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

					<fieldset
						className="flex items-center gap-1"
						aria-label="品種・区分・格付けフィルタ"
					>
						{kindFacets.map((kf) =>
							kf.multi ? (
								<KindFacetMenu
									key={kf.kind}
									kf={kf}
									label={kindLabelJa(kf.kind, region.id)}
									hideSet={hideSet}
									onToggle={toggleToken}
								/>
							) : (
								<KindToggle
									key={kf.kind}
									kind={kf.kind}
									label={kindLabelJa(kf.kind, region.id)}
									active={!hideSet.has(kindToken(kf.kind))}
									onToggle={() => toggleToken(kindToken(kf.kind))}
								/>
							),
						)}
						<GrapeFilterMenu
							value={grape}
							onChange={(v) => setSearch({ grape: v })}
						/>
					</fieldset>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1">
				{isListView ? (
					<div className="min-w-0 flex-1 overflow-y-auto">
						<div className="mx-auto max-w-2xl">
							{colorMode === "progress" && (
								<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-xs">
									<span className="font-medium">クイズ正解率</span>
									<span className="flex items-center gap-1.5">
										<span className="text-muted-foreground">少</span>
										<span
											className="inline-block size-3.5 rounded-sm"
											style={{ backgroundColor: PROGRESS_EMPTY_COLOR.fill }}
											title="未正解"
										/>
										{PROGRESS_BUCKETS.map((b) => (
											<span
												key={b.fill}
												className="inline-block size-3.5 rounded-sm"
												style={{ backgroundColor: b.fill }}
											/>
										))}
										<span className="text-muted-foreground">多</span>
									</span>
									{!isAuthenticated && (
										<span className="ml-auto flex items-center gap-2">
											<span className="text-muted-foreground">
												ログインで進捗を記録
											</span>
											<Button asChild size="sm" variant="secondary">
												<Link to="/login">
													<LogInIcon className="size-3.5" aria-hidden />
													ログイン
												</Link>
											</Button>
										</span>
									)}
								</div>
							)}
							{treeList}
						</div>
					</div>
				) : (
					<AopMapView
						region={region}
						aops={aops}
						selectedAopId={selectedAopId}
						grapeVarietyId={grape}
						hiddenAopIds={hiddenAopIds}
						colorMode={colorMode}
						progressByIdApp={progressByIdApp}
						onSelectAop={selectFromMap}
						getFitInset={getInset}
						className="min-w-0 flex-1"
					/>
				)}

				{/* 進捗モードの凡例・未ログイン促し(地図表示時のみ) */}
				{!isListView && colorMode === "progress" && (
					<>
						<div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
							<div className="mb-1 font-medium">クイズ正解率</div>
							<div className="flex items-center gap-1.5">
								<span className="text-muted-foreground">少</span>
								<span
									className="inline-block size-3.5 rounded-sm"
									style={{ backgroundColor: PROGRESS_EMPTY_COLOR.fill }}
									title="未正解"
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
										ログインすると学習の進捗が地図・リストに表示されます
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
							<SelectedAopPanel
								aop={selectedAop}
								ancestry={selectedAncestry}
								onSelectAop={navigateRelated}
								onPrev={goPrev}
								onNext={goNext}
								position={siblings}
								onClose={() => selectFresh(undefined)}
								quizQuestionCount={selectedAopQuizCount}
								onStartQuiz={startAopQuiz}
								affiliate={affiliate}
								aops={aops}
								regions={REGIONS}
								onSelectRegion={selectRegion}
								onBack={goBack}
								backToName={backToName}
								referenceLinksSlot={referenceLinksSlot}
								isListView={isListView}
								onShowMap={() => setSearch({ view: undefined })}
							/>
						) : (
							treeList
						)}
					</aside>
				)}

				{/* モバイル: 詳細を下部オーバーレイで表示。ハンドルを下スワイプで閉じる */}
				{selectedAop && (
					<MobileDetailSheet
						panelRef={panelRef}
						onDismiss={() => selectFresh(undefined)}
						className="absolute inset-x-2 bottom-2 lg:hidden"
					>
						<SelectedAopPanel
							aop={selectedAop}
							ancestry={selectedAncestry}
							onSelectAop={navigateRelated}
							onPrev={goPrev}
							onNext={goNext}
							position={siblings}
							quizQuestionCount={selectedAopQuizCount}
							onStartQuiz={startAopQuiz}
							affiliate={affiliate}
							aops={aops}
							regions={REGIONS}
							onSelectRegion={selectRegion}
							onBack={goBack}
							backToName={backToName}
							referenceLinksSlot={referenceLinksSlot}
							isListView={isListView}
							onShowMap={() => setSearch({ view: undefined })}
						/>
					</MobileDetailSheet>
				)}
			</div>

			<MapQuizDialog
				open={quizScope !== null}
				onOpenChange={(open) => {
					if (!open) setQuizScope(null);
				}}
				regionId={region.id}
				regionNameJa={region.nameJa}
				scopeAop={
					quizScope?.kind === "aop"
						? aops.find((a) => a.id === quizScope.aopId)
						: undefined
				}
				isAuthenticated={isAuthenticated}
			/>

			<RegionChatDialog
				open={chatOpen}
				onOpenChange={setChatOpen}
				regionId={region.id}
				regionNameJa={region.nameJa}
				aopId={selectedAop?.id}
				aopNameJa={selectedAop?.nameJa}
				isAuthenticated={isAuthenticated}
			/>
		</main>
	);
}

// 区分フィルタの表示名。畑(vineyard)は地域固有の呼称(ブルゴーニュ=クリマ /
// アルザス=リュー・ディ / それ以外=畑名)を使い、他区分は総称ラベルを使う。
function kindLabelJa(kind: AopKind, regionId: string): string {
	return kind === "vineyard"
		? getVineyardTermJa(regionId)
		: KIND_LABELS_JA[kind];
}

// 格付けを持たない(または1種のみの)区分の単純トグルチップ。
function KindToggle({
	kind,
	label,
	active,
	onToggle,
}: {
	kind: AopKind;
	label: string;
	active: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={active}
			className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
				active
					? "border-transparent text-white"
					: "border-border text-muted-foreground hover:border-foreground/40"
			}`}
			style={active ? { backgroundColor: KIND_COLORS[kind].fill } : undefined}
		>
			{label}
		</button>
	);
}

// 格付けを2種以上持つ区分のマルチセレクトチップ。区分名のボタンを押すと格付けの
// サブ選択肢(特級/1級/…、必要なら格付けなし)がドロップダウンで開く。
// ボタンの見た目: 0個選択=非選択 / 全選択=選択 / 一部のみ選択=選択+漏斗アイコン
// (一部だけに絞り込み中であることを示す)。
function KindFacetMenu({
	kf,
	label,
	hideSet,
	onToggle,
}: {
	kf: KindFacets;
	label: string;
	hideSet: ReadonlySet<string>;
	onToggle: (token: string) => void;
}) {
	const facets = groupFacets(kf);
	const tokens = groupTokens(kf);
	const selectedCount = tokens.filter((t) => !hideSet.has(t)).length;
	const anySelected = selectedCount > 0;
	const partial = selectedCount > 0 && selectedCount < tokens.length;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-pressed={anySelected}
					className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
						anySelected
							? "border-transparent text-white"
							: "border-border text-muted-foreground hover:border-foreground/40"
					}`}
					style={
						anySelected
							? { backgroundColor: KIND_COLORS[kf.kind].fill }
							: undefined
					}
				>
					{label}
					{partial && (
						<FunnelIcon
							className="size-3 fill-current"
							aria-label="一部の格付けで絞り込み中"
						/>
					)}
					<ChevronDownIcon className="size-3" aria-hidden />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{facets.map((facet) => {
					const token = facetToken(kf.kind, facet);
					const checked = !hideSet.has(token);
					return (
						<DropdownMenuItem
							key={token}
							// トグルしてもメニューを閉じない(複数選択を続けやすく)
							onSelect={(e) => {
								e.preventDefault();
								onToggle(token);
							}}
							className="gap-2"
						>
							<Checkbox checked={checked} className="pointer-events-none" />
							{facetLabelJa(facet)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
