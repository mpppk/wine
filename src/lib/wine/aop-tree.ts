import { classificationRank } from "./tags";
import type { Aop, Region, Subregion } from "./types";

// リスト表示用の階層ツリー(地区 > 村名AOC > 畑/シャトー)を組み立てる。
// 複数村にまたがる畑(villageAopIds が複数)は各村の下に重複して現れる。
// ボルドーのシャトー(winery)は所属AOCの下に格付け順で並べる。

export interface VillageNode {
	village: Aop;
	vineyards: Aop[];
	/** この村/地区AOCに属するシャトー(ボルドー)。格付け順に並ぶ */
	wineries: Aop[];
}

export interface SubregionSection {
	subregion: Subregion;
	/** 地方名AOC(広域)。村の外側に位置づけて先頭に表示する */
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
	const villageNodes = new Map<string, VillageNode>();

	// 村を先に配置してから、畑・シャトーを親AOCへぶら下げる
	for (const aop of aops) {
		const section = bySubregion.get(aop.subregionId);
		if (!section) continue;
		if (aop.kind === "regional") {
			section.regionalAops.push(aop);
		} else if (aop.kind === "village") {
			const node: VillageNode = { village: aop, vineyards: [], wineries: [] };
			villageNodes.set(aop.id, node);
			section.villages.push(node);
		}
	}
	for (const aop of aops) {
		if (aop.kind !== "vineyard" && aop.kind !== "winery") continue;
		const parents = (aop.villageAopIds ?? [])
			.map((id) => villageNodes.get(id))
			.filter((n) => n !== undefined);
		if (parents.length === 0) {
			const section = bySubregion.get(aop.subregionId);
			if (aop.kind === "winery") section?.unassignedWineries.push(aop);
			else section?.unassignedVineyards.push(aop);
		} else {
			for (const parent of parents) {
				if (aop.kind === "winery") parent.wineries.push(aop);
				else parent.vineyards.push(aop);
			}
		}
	}
	// 各村のシャトーを格付け順(第1級→第5級)に整列。同順位は入力順を保つ
	for (const node of villageNodes.values()) {
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
	 */
	villages: Aop[];
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
	const villages = (aop.villageAopIds ?? [])
		.map((id) => byId.get(id))
		.filter((a): a is Aop => a !== undefined);
	const subregion = region.subregions.find((s) => s.id === aop.subregionId);
	return {
		regionNameJa: region.nameJa,
		subregionNameJa: aop.kind === "regional" ? undefined : subregion?.nameJa,
		villages,
	};
}
