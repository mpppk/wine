import { classificationRank } from "./tags";
import type { Aop, Region, Subregion } from "./types";

// リスト表示用の階層ツリー(地区 > 村名/地区AOC > 畑 > クリマ / シャトー)を組み立てる。
// 複数村にまたがる畑(villageAopIds が複数)は各村の下に重複して現れる。
// 個別クリマ(parentAopId を持つ畑)は親畑(総称AOC/合成総称ノード)の下に入れ子で並ぶ。
// ボルドーのシャトー(winery)は所属AOCの下に格付け順で並べる。所属先は村名AOC
// (ポイヤック等)だけでなく地区AOC(オー・メドック等 = kind:regional)のこともあり、
// その場合は該当の地区AOCを親ノードとして村の前に表示する。

/** 畑(総称AOC/畑名AOC)と、その中に内包される個別クリマ。 */
export interface VineyardNode {
	vineyard: Aop;
	/** parentAopId でこの畑に紐づく個別クリマ。入力順を保つ */
	climats: Aop[];
}

export interface VillageNode {
	/** 親となるAOC(村名 village または子を持つ地区 regional) */
	village: Aop;
	vineyards: VineyardNode[];
	/** この村/地区AOCに属するシャトー(ボルドー)。格付け順に並ぶ */
	wineries: Aop[];
}

export interface SubregionSection {
	subregion: Subregion;
	/** 子(畑・シャトー)を持たない地方名AOC(広域)。村の外側に先頭表示する */
	regionalAops: Aop[];
	villages: VillageNode[];
	/** villageAopIds を持たない畑のフォールバック置き場 */
	unassignedVineyards: Aop[];
	/** 親AOCがリストに含まれないシャトーのフォールバック置き場 */
	unassignedWineries: Aop[];
}

export function buildAopTree(
	aops: Aop[],
	subregions: Subregion[],
): SubregionSection[] {
	const sections = subregions.map((subregion) => ({
		subregion,
		regionalAops: [] as Aop[],
		villages: [] as VillageNode[],
		unassignedVineyards: [] as Aop[],
		unassignedWineries: [] as Aop[],
	}));
	const bySubregion = new Map(sections.map((s) => [s.subregion.id, s]));
	// 村名AOC・地区AOCの双方を親候補ノードにする(id で引ける)
	const parentNodes = new Map<string, VillageNode>();
	const regionalNodes: {
		node: VillageNode;
		section: (typeof sections)[number];
	}[] = [];

	for (const aop of aops) {
		const section = bySubregion.get(aop.subregionId);
		if (!section) continue;
		if (aop.kind === "village") {
			const node: VillageNode = { village: aop, vineyards: [], wineries: [] };
			parentNodes.set(aop.id, node);
			section.villages.push(node);
		} else if (aop.kind === "regional") {
			// 地区AOCは子が付くかどうかで表示先が変わるため、判定を後回しにする
			const node: VillageNode = { village: aop, vineyards: [], wineries: [] };
			parentNodes.set(aop.id, node);
			regionalNodes.push({ node, section });
		}
	}
	// 畑(トップレベル)とシャトーを村/地区ノードに割り当てる。個別クリマ
	// (parentAopId を持つ畑)は次のパスで親畑ノードに入れるためここでは飛ばす。
	// 複数村にまたがる畑は村ごとに VineyardNode インスタンスを作るため、id で
	// 全インスタンスを引けるようにしておく(クリマは全インスタンスに現れる)。
	const vineyardNodesById = new Map<string, VineyardNode[]>();
	for (const aop of aops) {
		if (aop.kind !== "vineyard" && aop.kind !== "winery") continue;
		if (aop.kind === "vineyard" && aop.parentAopId) continue; // クリマは後段で処理
		const parents = (aop.villageAopIds ?? [])
			.map((id) => parentNodes.get(id))
			.filter((n) => n !== undefined);
		if (parents.length === 0) {
			const section = bySubregion.get(aop.subregionId);
			if (aop.kind === "winery") section?.unassignedWineries.push(aop);
			else section?.unassignedVineyards.push(aop);
		} else {
			for (const parent of parents) {
				if (aop.kind === "winery") {
					parent.wineries.push(aop);
				} else {
					const node: VineyardNode = { vineyard: aop, climats: [] };
					parent.vineyards.push(node);
					const list = vineyardNodesById.get(aop.id) ?? [];
					list.push(node);
					vineyardNodesById.set(aop.id, list);
				}
			}
		}
	}
	// 個別クリマ(parentAopId を持つ畑)を親畑ノードに入れ子で割り当てる。
	// 親畑が(複数村ぶん)複数ノードあれば各ノードの下に現れる。親が見つからない
	// ものは畑と同じフォールバック置き場(unassignedVineyards)に置く。
	for (const aop of aops) {
		if (aop.kind !== "vineyard" || !aop.parentAopId) continue;
		const parentNodes2 = vineyardNodesById.get(aop.parentAopId);
		if (parentNodes2?.length) {
			for (const node of parentNodes2) node.climats.push(aop);
		} else {
			bySubregion.get(aop.subregionId)?.unassignedVineyards.push(aop);
		}
	}
	// 地区AOC: 子(シャトー/畑)が付いたものは親ノードとして村の前に、
	// 付かないものは従来どおりフラットな地方名AOC行にする
	for (const { node, section } of regionalNodes) {
		if (node.wineries.length > 0 || node.vineyards.length > 0) {
			section.villages.unshift(node);
		} else {
			section.regionalAops.push(node.village);
		}
	}
	// シャトーを格付け順(第1級→第5級)に整列。同順位は入力順を保つ
	for (const node of parentNodes.values()) {
		if (node.wineries.length > 1) {
			node.wineries = stableSortByRank(node.wineries);
		}
	}
	for (const section of sections) {
		if (section.unassignedWineries.length > 1) {
			section.unassignedWineries = stableSortByRank(section.unassignedWineries);
		}
	}
	return sections;
}

function stableSortByRank(aops: Aop[]): Aop[] {
	return aops
		.map((aop, i) => ({ aop, i }))
		.sort(
			(a, b) =>
				classificationRank(a.aop) - classificationRank(b.aop) || a.i - b.i,
		)
		.map((x) => x.aop);
}

/**
 * ツリーを AopTreeList の表示順どおりにフラット化する。
 * セクション順に regionalAops → 各村(村本体 → 畑 → クリマ → シャトー) →
 * unassignedVineyards → unassignedWineries を積む(AopTreeList.tsx の描画順と一致)。
 * 複数村にまたがる畑/クリマは複数村の下に現れるため、id で重複排除(初出のみ採用)する。
 */
export function flattenAopTree(sections: SubregionSection[]): Aop[] {
	const out: Aop[] = [];
	const seen = new Set<string>();
	const push = (a: Aop) => {
		if (seen.has(a.id)) return;
		seen.add(a.id);
		out.push(a);
	};
	for (const section of sections) {
		for (const a of section.regionalAops) push(a);
		for (const node of section.villages) {
			push(node.village);
			for (const vNode of node.vineyards) {
				push(vNode.vineyard);
				for (const a of vNode.climats) push(a);
			}
			for (const a of node.wineries) push(a);
		}
		for (const a of section.unassignedVineyards) push(a);
		for (const a of section.unassignedWineries) push(a);
	}
	return out;
}

export interface AopSiblings {
	/** 前の同一区分AOPのid。先頭なら undefined */
	prevId?: string;
	/** 次の同一区分AOPのid。末尾なら undefined */
	nextId?: string;
	/** 同一区分シーケンス内での 0 始まりの位置。見つからなければ -1 */
	index: number;
	/** 同一区分シーケンスの総数 */
	total: number;
}

/**
 * フラット化済みの並び(flattenAopTree の結果)から、選択中AOPと同じ区分(kind)の
 * 前後のAOPを求める。フィルタ表示中のものだけを対象にする場合は visibleAopIds を渡す
 * (未指定なら全件を表示中とみなす)。「順番にざーっと見て学習する」ための前後移動に使う。
 */
export function getSameKindSiblings(
	ordered: Aop[],
	selected: Aop,
	visibleAopIds?: ReadonlySet<string>,
): AopSiblings {
	// 同一 kind でグループ化するが、畑(vineyard)は入れ子の粒度で分ける:
	// 個別クリマは同じ親のクリマ同士、トップレベルの畑はトップ畑同士で前後移動する
	// (kind:vineyard に両者が混在するため parentAopId でグループを切る)。
	const groupKey = (a: Aop): string =>
		a.kind === "vineyard" ? (a.parentAopId ?? "<top-vineyard>") : a.kind;
	const selectedKey = groupKey(selected);
	const sequence = ordered.filter(
		(a) =>
			groupKey(a) === selectedKey &&
			(visibleAopIds === undefined || visibleAopIds.has(a.id)),
	);
	const index = sequence.findIndex((a) => a.id === selected.id);
	return {
		prevId: index > 0 ? sequence[index - 1].id : undefined,
		nextId:
			index >= 0 && index < sequence.length - 1
				? sequence[index + 1].id
				: undefined,
		index,
		total: sequence.length,
	};
}

/** 詳細パネルで「所属する親」を表示するための、あるAOPの上位階層情報 */
export interface AopAncestry {
	/** 地方(例: ブルゴーニュ) */
	regionNameJa: string;
	/**
	 * 地区(例: コート・ド・ボーヌ)。
	 * 地方名AOC(広域)は合成の器なので地区としては扱わず undefined を返す。
	 */
	subregionNameJa?: string;
	/**
	 * 畑が所属する村名AOC。畑は複数村にまたがることがあるため配列で返す
	 * (例: モンラシェはピュリニーとシャサーニュの2村に属する)。villageAopIds の順序を保つ。
	 * クリマ(parentAopId を持つ畑)の場合は親畑の villageAopIds から導出する。
	 */
	villages: Aop[];
	/**
	 * クリマ(parentAopId を持つ畑)の場合、内包される親畑(総称AOC/合成総称ノード)。
	 * それ以外は undefined。
	 */
	parentVineyard?: Aop;
}

/**
 * 選択されたAOPの所属親(村名AOC・地区・地方)を解決する。
 * `aops` は同一地方の全AOP(親村を id で引くのに使う)。
 */
export function getAopAncestry(
	aop: Aop,
	aops: Aop[],
	region: Region,
): AopAncestry {
	const byId = new Map(aops.map((a) => [a.id, a]));
	// クリマは村を親畑から導出する。通常の畑/シャトーは自身の villageAopIds を使う。
	const parentVineyard = aop.parentAopId
		? byId.get(aop.parentAopId)
		: undefined;
	const villageIds = parentVineyard
		? (parentVineyard.villageAopIds ?? [])
		: (aop.villageAopIds ?? []);
	const villages = villageIds
		.map((id) => byId.get(id))
		.filter((a): a is Aop => a !== undefined);
	const subregion = region.subregions.find((s) => s.id === aop.subregionId);
	return {
		regionNameJa: region.nameJa,
		subregionNameJa: aop.kind === "regional" ? undefined : subregion?.nameJa,
		villages,
		parentVineyard,
	};
}
