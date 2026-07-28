import { CircleCheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import {
	buildAopTree,
	type SubregionSection,
	type VillageNode,
	type VineyardNode,
} from "#/lib/wine/aop-tree";
import {
	GRAND_CRU_TAG_COLOR,
	KIND_COLORS,
	PROGRESS_BUCKETS,
	PROGRESS_EMPTY_COLOR,
} from "#/lib/wine/map-style";
import { classificationBadgeJa, isLegalAppellation } from "#/lib/wine/tags";
import type { Aop, Subregion } from "#/lib/wine/types";

/**
 * 行の選択ハンドラ。同じAOPが複数の村の下に現れうるため、AOP id に加えて
 * 「どの行か」を一意に表す rowKey(祖先ノードのidを連ねたパス)を渡す。
 */
type RowSelect = (aopId: string, rowKey: string) => void;

/** AOP(slug)単位の正解進捗。solved=正解済み問題数 / total=候補問題総数 */
export interface AopProgress {
	solved: number;
	total: number;
}

export interface AopTreeListProps {
	/** 地域の全AOP。ツリー構造(村→畑の親子)はフィルタに関係なく全量から組む */
	aops: Aop[];
	subregions: Subregion[];
	/** フィルタ(品種・区分・タグ)を通過したAOPのid。含まれない行は非表示になる */
	visibleAopIds: ReadonlySet<string>;
	selectedAopId?: string;
	onSelect: (aopId: string) => void;
	/**
	 * 色分けモード。地図の塗りと同じく「色」(行のドット)だけに効く。
	 * 格付けバッジと進捗ピルは行の別チャンネル(バッジ列)なので、このモードに
	 * 関わらず併記される(進捗ピルの表示条件は isAuthenticated を参照)。
	 */
	colorMode?: "kind" | "progress";
	/**
	 * ログイン状態。未ログイン時は正解数が記録されず "0/total" が増えないため、
	 * 進捗ピルを分数ではなく出題数(クイズN問)の中立表示に切り替えたうえで、
	 * 全行に同じピルが並ぶのを避けて colorMode="progress" のときだけ出す。
	 * 省略時はログイン扱い。
	 */
	isAuthenticated?: boolean;
	/**
	 * AOP(slug)ごとの「そのAOP自身が主語」の正解進捗(solved/total)。
	 * 地区見出しの合算(配下の重複しない総数)に使う。未取得時は進捗を表示しない。
	 */
	progressByAopId?: Record<string, AopProgress>;
	/**
	 * AOP(slug)ごとの「自身+階層近傍」の正解進捗(solved/total)。詳細パネルの
	 * 「関連クイズ数」と同じスコープで、各AOP行(村・畑・クリマ)の分母表示に使う。
	 * 未指定時は progressByAopId(自身のみ)にフォールバックする。
	 */
	rowProgressByAopId?: Record<string, AopProgress>;
	/**
	 * 選択行をスクロールで表示させる際に下端から除外する量(px)を返す getter。
	 * モバイルでは詳細パネルがリスト下部に重なるため、その被覆量を渡すと選択行が
	 * パネルの裏に隠れない位置まで送られる。省略時・デスクトップでは 0。
	 */
	getScrollInset?: () => { bottom: number };
}

/**
 * 地区 > 村名AOC > 畑 の階層でAOPを一覧表示する。
 * 地図表示時のサイドバーとリスト表示の両方で使う。
 */
export function AopTreeList({
	aops,
	subregions,
	visibleAopIds,
	selectedAopId,
	onSelect,
	colorMode = "kind",
	progressByAopId,
	rowProgressByAopId,
	isAuthenticated = true,
	getScrollInset,
}: AopTreeListProps) {
	// 各行(村・畑・クリマ)は「自身+近傍」スコープの進捗を出す。未指定なら自身のみ。
	const rowProgress = rowProgressByAopId ?? progressByAopId;
	const sections = useMemo(
		() => buildAopTree(aops, subregions),
		[aops, subregions],
	);

	// ドット(と地図の塗り)を正解率で着色するか。色分けモードはこの「色」だけに効く。
	const progressDot = colorMode === "progress";
	// 進捗ピルを出すか。区分と進捗は行の別チャンネル(ドット色 / バッジ列)を使うので
	// 排他にする必要はなく、ログイン済みなら色分けモードに関係なく常に併記する。
	// 未ログインは正解が記録されず "クイズN問" の中立表示にしかならないため、
	// 全行に同じピルが並ぶノイズを避けて進捗モードを選んだときだけ出す。
	const showProgress = isAuthenticated || progressDot;
	// 未ログイン時は正解が記録されず分数(0/total)が動かないため、出題数だけを示す
	const countOnly = !isAuthenticated;

	// 直前にユーザーが押した行(の rowKey)。複数村にまたがる畑(ボンヌ・マール等)は
	// 同じAOPが村ごとに複数行現れるため、AOP id だけではどの行が押されたか決まらない。
	// 押された行そのものへスクロールするために覚えておく(選択状態は id 単位なので
	// 再描画は不要 = state ではなく ref)。id が現在の選択と一致するときだけ使う。
	const activeRowRef = useRef<{ aopId: string; rowKey: string } | null>(null);
	const handleRowSelect = (aopId: string, rowKey: string) => {
		activeRowRef.current = { aopId, rowKey };
		onSelect(aopId);
	};

	// 選択AOPが変わったら、その行をスクロール表示領域内に入れる。情報パネルの
	// 前へ/次へ(←/→)で領域外のAOPへ移った際、リストの選択位置を見失わないため。
	// モバイルでは詳細パネルがリスト下部に重なるので、被覆量(getScrollInset().bottom)
	// を除いた「実際に見えている範囲」に行が収まるよう、最寄りのスクロール祖先を
	// 必要な分だけ動かす。既に見えている行では動かさない。block:"nearest" +
	// scroll-margin ではブラウザ差で下端補正が効かないことがあるため手動計算する。
	// getInset は fitBounds と同様にスクロール実行時の最新実測値を読む getter。
	//
	// 同じAOPの行が複数ある場合の対象行は、
	//   1. 直前に押された行(あればそれが唯一の正解。押した行以外へ飛ぶのを防ぐ)
	//   2. なければ(地図クリック・前へ/次へ等)現在のスクロール位置から最も近い行
	// とする。常に先頭行を採ると、2つ目以降の行を押したときに1つ目へ飛んでしまう。
	const navRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!selectedAopId) return;
		// セレクタに値を埋め込まず dataset で突き合わせる(id のエスケープ不要)
		const rows = Array.from(
			navRef.current?.querySelectorAll<HTMLElement>("[data-aop-id]") ?? [],
		).filter((r) => r.dataset.aopId === selectedAopId);
		const first = rows[0];
		if (!first) return;
		const active = activeRowRef.current;
		const tapped =
			active?.aopId === selectedAopId
				? rows.find((r) => r.dataset.aopRowKey === active.rowKey)
				: undefined;
		let scroller = first.parentElement;
		while (scroller && scroller !== document.body) {
			const oy = getComputedStyle(scroller).overflowY;
			if (oy === "auto" || oy === "scroll") break;
			scroller = scroller.parentElement;
		}
		if (!scroller || scroller === document.body) {
			(tapped ?? first).scrollIntoView({ block: "nearest" });
			return;
		}
		const inset = getScrollInset?.().bottom ?? 0;
		const view = scroller.getBoundingClientRect();
		const visibleTop = view.top;
		const visibleBottom = view.bottom - inset;
		// 行を可視範囲に収めるのに必要なスクロール量。0 なら既に見えている。
		const scrollDelta = (row: HTMLElement): number => {
			const r = row.getBoundingClientRect();
			if (r.bottom > visibleBottom) return r.bottom - visibleBottom;
			if (r.top < visibleTop) return r.top - visibleTop;
			return 0;
		};
		const target =
			tapped ??
			rows.reduce((best, r) =>
				Math.abs(scrollDelta(r)) < Math.abs(scrollDelta(best)) ? r : best,
			);
		const delta = scrollDelta(target);
		if (delta !== 0) scroller.scrollTop += delta;
	}, [selectedAopId, getScrollInset]);

	const visibleSections = sections
		.map((section) => {
			const regionalAops = section.regionalAops.filter((a) =>
				visibleAopIds.has(a.id),
			);
			const villages = section.villages
				.map((node) => ({
					...node,
					// 畑ノードは、畑本体か配下クリマのいずれかが表示対象なら残し、
					// クリマはフィルタ通過分だけに絞る
					vineyards: node.vineyards
						.map((vn) => ({
							...vn,
							climats: vn.climats.filter((c) => visibleAopIds.has(c.id)),
						}))
						.filter(
							(vn) =>
								visibleAopIds.has(vn.vineyard.id) || vn.climats.length > 0,
						),
					wineries: node.wineries.filter((a) => visibleAopIds.has(a.id)),
				}))
				.filter(
					(node) =>
						visibleAopIds.has(node.village.id) ||
						node.vineyards.length > 0 ||
						node.wineries.length > 0,
				);
			const unassignedVineyards = section.unassignedVineyards.filter((a) =>
				visibleAopIds.has(a.id),
			);
			const unassignedWineries = section.unassignedWineries.filter((a) =>
				visibleAopIds.has(a.id),
			);
			return {
				...section,
				regionalAops,
				villages,
				unassignedVineyards,
				unassignedWineries,
			};
		})
		.filter(
			(s) =>
				s.regionalAops.length > 0 ||
				s.villages.length > 0 ||
				s.unassignedVineyards.length > 0 ||
				s.unassignedWineries.length > 0,
		);

	if (visibleSections.length === 0) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				条件に一致するAOPがありません。フィルタを変更してください。
			</p>
		);
	}

	return (
		<nav aria-label="AOP一覧" className="p-2" ref={navRef}>
			{visibleSections.map((section) => {
				// 地区見出しには配下(表示中)AOPを合算した正解進捗を併記する
				const sectionProgress = showProgress
					? sumProgress(
							collectSectionAopIds(section, visibleAopIds),
							progressByAopId,
						)
					: undefined;
				return (
					<section key={section.subregion.id} className="mb-4">
						<h3 className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
							<span className="uppercase tracking-wide">
								{section.subregion.nameJa}
							</span>
							{sectionProgress && (
								<ProgressIndicator
									progress={sectionProgress}
									countOnly={countOnly}
								/>
							)}
						</h3>
						{section.regionalAops.length > 0 && (
							<ul>
								{section.regionalAops.map((aop) => (
									<li key={aop.id}>
										<AopRow
											aop={aop}
											rowKey={`${section.subregion.id}/${aop.id}`}
											selected={aop.id === selectedAopId}
											onSelect={handleRowSelect}
											progressDot={progressDot}
											showProgress={showProgress}
											countOnly={countOnly}
											progress={rowProgress?.[aop.id]}
										/>
									</li>
								))}
							</ul>
						)}
						{section.villages.length > 0 && (
							<ul>
								{section.villages.map((node) => (
									<VillageItem
										key={node.village.id}
										node={node}
										pathPrefix={section.subregion.id}
										villageVisible={visibleAopIds.has(node.village.id)}
										visibleAopIds={visibleAopIds}
										selectedAopId={selectedAopId}
										onSelect={handleRowSelect}
										progressDot={progressDot}
										showProgress={showProgress}
										countOnly={countOnly}
										rowProgressByAopId={rowProgress}
									/>
								))}
							</ul>
						)}
						{section.unassignedVineyards.length > 0 && (
							<ul>
								{section.unassignedVineyards.map((aop) => (
									<li key={aop.id}>
										<AopRow
											aop={aop}
											rowKey={`${section.subregion.id}/${aop.id}`}
											selected={aop.id === selectedAopId}
											onSelect={handleRowSelect}
											progressDot={progressDot}
											showProgress={showProgress}
											countOnly={countOnly}
											progress={rowProgress?.[aop.id]}
										/>
									</li>
								))}
							</ul>
						)}
						{section.unassignedWineries.length > 0 && (
							<ul>
								{section.unassignedWineries.map((aop) => (
									<li key={aop.id}>
										<AopRow
											aop={aop}
											rowKey={`${section.subregion.id}/${aop.id}`}
											selected={aop.id === selectedAopId}
											onSelect={handleRowSelect}
											progressDot={progressDot}
											showProgress={showProgress}
											countOnly={countOnly}
											progress={rowProgress?.[aop.id]}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</nav>
	);
}

function VillageItem({
	node,
	pathPrefix,
	villageVisible,
	visibleAopIds,
	selectedAopId,
	onSelect,
	progressDot,
	showProgress,
	countOnly,
	rowProgressByAopId,
}: {
	node: VillageNode;
	/** 祖先ノードの rowKey。この村配下の行の rowKey はここから組み立てる */
	pathPrefix: string;
	villageVisible: boolean;
	visibleAopIds: ReadonlySet<string>;
	selectedAopId?: string;
	onSelect: RowSelect;
	progressDot: boolean;
	showProgress: boolean;
	countOnly: boolean;
	rowProgressByAopId?: Record<string, AopProgress>;
}) {
	// 村行は村AOP自身の「自身+近傍」スコープの進捗を出す(詳細パネルの関連クイズ数と一致)
	const villageProgress = showProgress
		? rowProgressByAopId?.[node.village.id]
		: undefined;
	const villageKey = `${pathPrefix}/${node.village.id}`;
	return (
		<li>
			{villageVisible ? (
				<AopRow
					aop={node.village}
					rowKey={villageKey}
					selected={node.village.id === selectedAopId}
					onSelect={onSelect}
					progressDot={progressDot}
					showProgress={showProgress}
					countOnly={countOnly}
					progress={villageProgress}
				/>
			) : (
				// 村自体はフィルタで非表示だが、配下の畑の位置づけを示すため
				// グルーピングラベルとしては残す
				<p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
					<span aria-hidden className="size-2.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate">{node.village.nameJa}</span>
					{villageProgress && (
						<ProgressIndicator
							progress={villageProgress}
							countOnly={countOnly}
						/>
					)}
				</p>
			)}
			{(node.vineyards.length > 0 || node.wineries.length > 0) && (
				<ul className="ml-4 border-l border-border pl-1">
					{node.vineyards.map((vn) => (
						<VineyardItem
							key={vn.vineyard.id}
							node={vn}
							pathPrefix={villageKey}
							vineyardVisible={visibleAopIds.has(vn.vineyard.id)}
							selectedAopId={selectedAopId}
							onSelect={onSelect}
							progressDot={progressDot}
							showProgress={showProgress}
							countOnly={countOnly}
							rowProgressByAopId={rowProgressByAopId}
						/>
					))}
					{node.wineries.map((aop) => (
						<li key={aop.id}>
							<AopRow
								aop={aop}
								rowKey={`${villageKey}/${aop.id}`}
								selected={aop.id === selectedAopId}
								onSelect={onSelect}
								progressDot={progressDot}
								showProgress={showProgress}
								countOnly={countOnly}
								progress={rowProgressByAopId?.[aop.id]}
							/>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

/** 畑(総称AOC/畑名AOC)と、その配下の個別クリマを入れ子表示する。 */
function VineyardItem({
	node,
	pathPrefix,
	vineyardVisible,
	selectedAopId,
	onSelect,
	progressDot,
	showProgress,
	countOnly,
	rowProgressByAopId,
}: {
	node: VineyardNode;
	/** 祖先ノード(村)の rowKey。複数村にまたがる畑はこれで行が区別される */
	pathPrefix: string;
	vineyardVisible: boolean;
	selectedAopId?: string;
	onSelect: RowSelect;
	progressDot: boolean;
	showProgress: boolean;
	countOnly: boolean;
	rowProgressByAopId?: Record<string, AopProgress>;
}) {
	const vineyardKey = `${pathPrefix}/${node.vineyard.id}`;
	return (
		<li>
			{vineyardVisible ? (
				<AopRow
					aop={node.vineyard}
					rowKey={vineyardKey}
					selected={node.vineyard.id === selectedAopId}
					onSelect={onSelect}
					progressDot={progressDot}
					showProgress={showProgress}
					countOnly={countOnly}
					progress={rowProgressByAopId?.[node.vineyard.id]}
				/>
			) : (
				// 畑本体はフィルタで非表示だが、配下クリマの位置づけを示すため
				// グルーピングラベルとして残す
				<p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
					<span aria-hidden className="size-2.5 shrink-0" />
					{node.vineyard.nameJa}
				</p>
			)}
			{node.climats.length > 0 && (
				<ul className="ml-4 border-l border-border pl-1">
					{node.climats.map((climat) => (
						<li key={climat.id}>
							<AopRow
								aop={climat}
								rowKey={`${vineyardKey}/${climat.id}`}
								selected={climat.id === selectedAopId}
								onSelect={onSelect}
								progressDot={progressDot}
								showProgress={showProgress}
								countOnly={countOnly}
								progress={rowProgressByAopId?.[climat.id]}
							/>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

function AopRow({
	aop,
	rowKey,
	selected,
	onSelect,
	progressDot = false,
	showProgress = false,
	countOnly = false,
	progress,
}: {
	aop: Aop;
	/**
	 * この行を一意に指す識別子(祖先ノードのidを "/" で連ねたパス)。
	 * 複数村にまたがる畑は同じAOPが複数行に現れるため、AOP id では行を特定できない。
	 */
	rowKey: string;
	selected: boolean;
	onSelect: RowSelect;
	/** ドットを区分色ではなく正解率で着色する(色分けモード) */
	progressDot?: boolean;
	/** 格付けバッジに加えて進捗インジケータも出す */
	showProgress?: boolean;
	/** 未ログイン時は進捗インジケータを分数でなく出題数(クイズN問)で表示する */
	countOnly?: boolean;
	/** この行に表示する正解進捗(そのAOPの「自身+階層近傍」スコープ) */
	progress?: AopProgress;
}) {
	// 格付けバッジ(特級/1級/2級/A 等)。特級もバッジで示す
	const badge = classificationBadgeJa(aop);
	// 畑階層(vineyard)で法的に独立AOCでないもの(個別クリマ・合成総称ノード)。
	// 該当する行(シャブリ特級クリマ等)は例外なく格付けバッジも持つため、テキストピルで
	// 併記するとバッジが3つ並んで最も幅の狭い階層で名前が潰れる。ドットを中抜きの
	// リングにして色チャンネル側に逃がし、テキストは支援技術向けの sr-only で残す。
	const nonAppellation = aop.kind === "vineyard" && !isLegalAppellation(aop);
	// 全問正解済みの行は淡い緑ティントで区別する(ホバー時は muted 優先)
	const complete =
		showProgress &&
		!!progress &&
		progress.total > 0 &&
		progress.solved >= progress.total;
	const dotColor = progressDot
		? progressDotColor(progress)
		: aop.tags?.includes("grand-cru")
			? GRAND_CRU_TAG_COLOR.fill
			: KIND_COLORS[aop.kind].fill;
	return (
		<button
			type="button"
			data-aop-id={aop.id}
			data-aop-row-key={rowKey}
			onClick={() => onSelect(aop.id, rowKey)}
			aria-current={selected || undefined}
			className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${
				selected ? "bg-muted font-medium" : complete ? "bg-emerald-500/10" : ""
			}`}
		>
			<span
				aria-hidden
				title={nonAppellation ? "非AOC" : undefined}
				className={`size-2.5 shrink-0 rounded-full ${nonAppellation ? "border-2" : ""}`}
				style={
					nonAppellation
						? { borderColor: dotColor }
						: { backgroundColor: dotColor }
				}
			/>
			{nonAppellation && <span className="sr-only">非AOC</span>}
			<span className="min-w-0 flex-1 truncate">{aop.nameJa}</span>
			{badge && (
				<span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
					{badge}
				</span>
			)}
			{showProgress && progress && (
				<ProgressIndicator progress={progress} countOnly={countOnly} />
			)}
		</button>
	);
}

/**
 * 正解進捗を "solved/total" のピルで示す。全問正解済みはチェック+緑で強調する。
 * countOnly(未ログイン)時は正解が記録されず分数が動かないため、代わりに
 * そのスコープの出題数を「クイズN問」の中立ピルで示す。
 */
function ProgressIndicator({
	progress,
	countOnly = false,
}: {
	progress: AopProgress;
	countOnly?: boolean;
}) {
	const { solved, total } = progress;
	if (total <= 0) return null;
	if (countOnly) {
		return (
			<span className="inline-flex shrink-0 items-center rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground">
				クイズ{total}問
			</span>
		);
	}
	const complete = solved >= total;
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] tabular-nums ${
				complete
					? "border border-transparent font-medium text-white"
					: "border border-border text-muted-foreground"
			}`}
			style={
				complete
					? {
							backgroundColor:
								PROGRESS_BUCKETS[PROGRESS_BUCKETS.length - 1]?.fill ??
								PROGRESS_EMPTY_COLOR.fill,
						}
					: undefined
			}
		>
			{complete && <CircleCheckIcon className="size-3" aria-hidden />}
			{/* 格付けバッジと隣り合うため、読み上げで "特級 12/20" が何の数かを示す */}
			<span className="sr-only">正解</span>
			{solved}/{total}
		</span>
	);
}

// 正解率(solved/total)をステータスドットの色に写す。地図の進捗色分けと同じ
// バケット境界(i/len)で着色し、正解ゼロ・未収載は「未正解」グレーにする。
function progressDotColor(progress: AopProgress | undefined): string {
	if (!progress || progress.total <= 0 || progress.solved <= 0) {
		return PROGRESS_EMPTY_COLOR.fill;
	}
	const rate = Math.min(1, progress.solved / progress.total);
	const idx = Math.min(
		PROGRESS_BUCKETS.length - 1,
		Math.floor(rate * PROGRESS_BUCKETS.length),
	);
	return PROGRESS_BUCKETS[idx]?.fill ?? PROGRESS_EMPTY_COLOR.fill;
}

// 複数AOPの正解進捗を合算する(村・地区の集計に使う)。
function sumProgress(
	ids: Iterable<string>,
	progressByAopId: Record<string, AopProgress> | undefined,
): AopProgress {
	let solved = 0;
	let total = 0;
	for (const id of ids) {
		const p = progressByAopId?.[id];
		if (!p) continue;
		solved += p.solved;
		total += p.total;
	}
	return { solved, total };
}

// 村ノード配下(表示中)のAOP idを集める。村本体+畑+クリマ+シャトー。
// 渡されるノードはフィルタ適用済み(climats/wineries は表示分のみ)。
function collectVillageAopIds(
	node: VillageNode,
	visibleAopIds: ReadonlySet<string>,
): string[] {
	const ids: string[] = [];
	if (visibleAopIds.has(node.village.id)) ids.push(node.village.id);
	for (const vn of node.vineyards) {
		if (visibleAopIds.has(vn.vineyard.id)) ids.push(vn.vineyard.id);
		for (const c of vn.climats) ids.push(c.id);
	}
	for (const w of node.wineries) ids.push(w.id);
	return ids;
}

// 地区セクション配下(表示中)の全AOP idを集める。
function collectSectionAopIds(
	section: Pick<
		SubregionSection,
		"regionalAops" | "villages" | "unassignedVineyards" | "unassignedWineries"
	>,
	visibleAopIds: ReadonlySet<string>,
): string[] {
	const ids: string[] = [];
	for (const a of section.regionalAops) ids.push(a.id);
	for (const node of section.villages) {
		ids.push(...collectVillageAopIds(node, visibleAopIds));
	}
	for (const a of section.unassignedVineyards) ids.push(a.id);
	for (const a of section.unassignedWineries) ids.push(a.id);
	return ids;
}
