import { useMemo } from "react";
import { buildAopTree, type VillageNode } from "#/lib/wine/aop-tree";
import { GRAND_CRU_TAG_COLOR, KIND_COLORS } from "#/lib/wine/map-style";
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

	const visibleSections = sections
		.map((section) => {
			const regionalAops = section.regionalAops.filter((a) =>
				visibleAopIds.has(a.id),
			);
			const villages = section.villages
				.map((node) => ({
					...node,
					vineyards: node.vineyards.filter((a) => visibleAopIds.has(a.id)),
				}))
				.filter(
					(node) =>
						visibleAopIds.has(node.village.id) || node.vineyards.length > 0,
				);
			const unassignedVineyards = section.unassignedVineyards.filter((a) =>
				visibleAopIds.has(a.id),
			);
			return { ...section, regionalAops, villages, unassignedVineyards };
		})
		.filter(
			(s) =>
				s.regionalAops.length > 0 ||
				s.villages.length > 0 ||
				s.unassignedVineyards.length > 0,
		);

	if (visibleSections.length === 0) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				条件に一致するAOPがありません。フィルタを変更してください。
			</p>
		);
	}

	return (
		<nav aria-label="AOP一覧" className="p-2">
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
				</section>
			))}
		</nav>
	);
}

function VillageItem({
	node,
	villageVisible,
	selectedAopId,
	onSelect,
}: {
	node: VillageNode;
	villageVisible: boolean;
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
			{node.vineyards.length > 0 && (
				<ul className="ml-4 border-l border-border pl-1">
					{node.vineyards.map((aop) => (
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

function AopRow({
	aop,
	selected,
	onSelect,
}: {
	aop: Aop;
	selected: boolean;
	onSelect: (aopId: string) => void;
}) {
	return (
		<button
			type="button"
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
			{aop.tags?.includes("premier-cru") && (
				<span className="shrink-0 text-[10px] text-muted-foreground">1er</span>
			)}
		</button>
	);
}
