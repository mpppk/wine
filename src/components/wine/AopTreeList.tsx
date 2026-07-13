import { useEffect, useMemo, useRef } from "react";
import {
	buildAopTree,
	type VillageNode,
	type VineyardNode,
} from "#/lib/wine/aop-tree";
import { GRAND_CRU_TAG_COLOR, KIND_COLORS } from "#/lib/wine/map-style";
import { classificationBadgeJa, isLegalAppellation } from "#/lib/wine/tags";
import type { Aop, Subregion } from "#/lib/wine/types";

export interface AopTreeListProps {
	/** 地域の全AOP。ツリー構造(村→畑の親子)はフィルタに関係なく全量から組む */
	aops: Aop[];
	subregions: Subregion[];
	/** フィルタ(品種・区分・タグ)を通過したAOPのid。含まれない行は非表示になる */
	visibleAopIds: ReadonlySet<string>;
	selectedAopId?: string;
	onSelect: (aopId: string) => void;
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
}: AopTreeListProps) {
	const sections = useMemo(
		() => buildAopTree(aops, subregions),
		[aops, subregions],
	);

	// 選択AOPが変わったら、その行をスクロール表示領域内に入れる。情報パネルの
	// 前へ/次へ(←/→)で領域外のAOPへ移った際、リストの選択位置を見失わないため。
	// スクロールコンテナは親(overflow-y-auto)側にあるので block:"nearest" で
	// 最寄りのスクロール祖先だけを最小限動かす(既に見えている行では動かない)。
	const navRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!selectedAopId) return;
		const row = navRef.current?.querySelector(
			`[data-aop-id="${CSS.escape(selectedAopId)}"]`,
		);
		row?.scrollIntoView({ block: "nearest" });
	}, [selectedAopId]);

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
			{visibleSections.map((section) => (
				<section key={section.subregion.id} className="mb-4">
					<h3 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{section.subregion.nameJa}
					</h3>
					{section.regionalAops.length > 0 && (
						<ul>
							{section.regionalAops.map((aop) => (
								<li key={aop.id}>
									<AopRow
										aop={aop}
										selected={aop.id === selectedAopId}
										onSelect={onSelect}
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
									villageVisible={visibleAopIds.has(node.village.id)}
									visibleAopIds={visibleAopIds}
									selectedAopId={selectedAopId}
									onSelect={onSelect}
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
										selected={aop.id === selectedAopId}
										onSelect={onSelect}
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
										selected={aop.id === selectedAopId}
										onSelect={onSelect}
									/>
								</li>
							))}
						</ul>
					)}
				</section>
			))}
		</nav>
	);
}

function VillageItem({
	node,
	villageVisible,
	visibleAopIds,
	selectedAopId,
	onSelect,
}: {
	node: VillageNode;
	villageVisible: boolean;
	visibleAopIds: ReadonlySet<string>;
	selectedAopId?: string;
	onSelect: (aopId: string) => void;
}) {
	return (
		<li>
			{villageVisible ? (
				<AopRow
					aop={node.village}
					selected={node.village.id === selectedAopId}
					onSelect={onSelect}
				/>
			) : (
				// 村自体はフィルタで非表示だが、配下の畑の位置づけを示すため
				// グルーピングラベルとしては残す
				<p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
					<span aria-hidden className="size-2.5 shrink-0" />
					{node.village.nameJa}
				</p>
			)}
			{(node.vineyards.length > 0 || node.wineries.length > 0) && (
				<ul className="ml-4 border-l border-border pl-1">
					{node.vineyards.map((vn) => (
						<VineyardItem
							key={vn.vineyard.id}
							node={vn}
							vineyardVisible={visibleAopIds.has(vn.vineyard.id)}
							selectedAopId={selectedAopId}
							onSelect={onSelect}
						/>
					))}
					{node.wineries.map((aop) => (
						<li key={aop.id}>
							<AopRow
								aop={aop}
								selected={aop.id === selectedAopId}
								onSelect={onSelect}
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
	vineyardVisible,
	selectedAopId,
	onSelect,
}: {
	node: VineyardNode;
	vineyardVisible: boolean;
	selectedAopId?: string;
	onSelect: (aopId: string) => void;
}) {
	return (
		<li>
			{vineyardVisible ? (
				<AopRow
					aop={node.vineyard}
					selected={node.vineyard.id === selectedAopId}
					onSelect={onSelect}
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
								selected={climat.id === selectedAopId}
								onSelect={onSelect}
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
	selected,
	onSelect,
}: {
	aop: Aop;
	selected: boolean;
	onSelect: (aopId: string) => void;
}) {
	// 格付けバッジ(特級/1級/2級/A 等)。特級もバッジで示し、非AOCバッジと同じ見た目に統一する
	const badge = classificationBadgeJa(aop);
	// 畑階層(vineyard)で法的に独立AOCでないもの(個別クリマ・合成総称ノード)には
	// 「非AOC」ラベルを出し、AOCである畑(グラン・クリュ等)と区別できるようにする
	const nonAppellation = aop.kind === "vineyard" && !isLegalAppellation(aop);
	return (
		<button
			type="button"
			data-aop-id={aop.id}
			onClick={() => onSelect(aop.id)}
			aria-current={selected || undefined}
			className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${
				selected ? "bg-muted font-medium" : ""
			}`}
		>
			<span
				aria-hidden
				className="size-2.5 shrink-0 rounded-full"
				style={{
					backgroundColor: aop.tags?.includes("grand-cru")
						? GRAND_CRU_TAG_COLOR.fill
						: KIND_COLORS[aop.kind].fill,
				}}
			/>
			<span className="min-w-0 flex-1 truncate">{aop.nameJa}</span>
			{nonAppellation && (
				<span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
					非AOC
				</span>
			)}
			{badge && (
				<span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
					{badge}
				</span>
			)}
		</button>
	);
}
