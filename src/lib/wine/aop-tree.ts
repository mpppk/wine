import type { Aop, Subregion } from "./types";

// リスト表示用の階層ツリー(地区 > 村名AOC > グラン・クリュ)を組み立てる。
// 複数村にまたがるグラン・クリュ(villageAopIds が複数)は各村の下に重複して現れる。

export interface VillageNode {
	village: Aop;
	grandCrus: Aop[];
}

export interface SubregionSection {
	subregion: Subregion;
	/** 地方名AOC(広域)。村の外側に位置づけて先頭に表示する */
	regionalAops: Aop[];
	villages: VillageNode[];
	/** villageAopIds を持たないグラン・クリュのフォールバック置き場 */
	unassignedGrandCrus: Aop[];
}

export function buildAopTree(
	aops: Aop[],
	subregions: Subregion[],
): SubregionSection[] {
	const sections = subregions.map((subregion) => ({
		subregion,
		regionalAops: [] as Aop[],
		villages: [] as VillageNode[],
		unassignedGrandCrus: [] as Aop[],
	}));
	const bySubregion = new Map(sections.map((s) => [s.subregion.id, s]));
	const villageNodes = new Map<string, VillageNode>();

	// 村を先に配置してから、グラン・クリュを親村へぶら下げる
	for (const aop of aops) {
		const section = bySubregion.get(aop.subregionId);
		if (!section) continue;
		if (aop.classification === "regional") {
			section.regionalAops.push(aop);
		} else if (aop.classification === "village") {
			const node: VillageNode = { village: aop, grandCrus: [] };
			villageNodes.set(aop.id, node);
			section.villages.push(node);
		}
	}
	for (const aop of aops) {
		if (aop.classification !== "grand-cru") continue;
		const parents = (aop.villageAopIds ?? [])
			.map((id) => villageNodes.get(id))
			.filter((n) => n !== undefined);
		if (parents.length === 0) {
			bySubregion.get(aop.subregionId)?.unassignedGrandCrus.push(aop);
		} else {
			for (const parent of parents) parent.grandCrus.push(aop);
		}
	}
	return sections;
}
