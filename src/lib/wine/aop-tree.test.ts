import { describe, expect, it } from "vitest";
import {
	buildAopTree,
	flattenAopTree,
	getAopAncestry,
	getSameKindSiblings,
} from "./aop-tree";
import { AOPS } from "./aops-data";
import { getRegion, listAops } from "./service";
import type { Aop, Region, Subregion } from "./types";

function aop(partial: Partial<Aop> & Pick<Aop, "id" | "kind">): Aop {
	return {
		idApp: 1,
		name: partial.id,
		shortName: partial.id,
		nameJa: partial.id,
		region: "bourgogne",
		subregionId: "sub-a",
		colors: ["red"],
		grapes: [{ varietyId: "pinot-noir", role: "principal" }],
		soil: "-",
		producers: [{ name: "-" }],
		description: "-",
		...partial,
	};
}

const SUBREGIONS: Subregion[] = [
	{ id: "sub-a", nameJa: "地区A" },
	{ id: "sub-b", nameJa: "地区B" },
];

describe("buildAopTree", () => {
	it("地区ごとに地方名AOC・村・畑を階層化する", () => {
		const aops = [
			aop({ id: "regional-1", kind: "regional" }),
			aop({ id: "village-1", kind: "village" }),
			aop({
				id: "gc-1",
				kind: "vineyard",
				villageAopIds: ["village-1"],
			}),
			aop({ id: "village-2", kind: "village", subregionId: "sub-b" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree).toHaveLength(2);
		expect(tree[0].regionalAops.map((a) => a.id)).toEqual(["regional-1"]);
		expect(tree[0].villages.map((v) => v.village.id)).toEqual(["village-1"]);
		expect(tree[0].villages[0].vineyards.map((vn) => vn.vineyard.id)).toEqual([
			"gc-1",
		]);
		expect(tree[1].villages.map((v) => v.village.id)).toEqual(["village-2"]);
	});

	it("複数村にまたがる畑は各村の下に重複して現れる", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "village-2", kind: "village" }),
			aop({
				id: "gc-shared",
				kind: "vineyard",
				villageAopIds: ["village-1", "village-2"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].villages[0].vineyards.map((vn) => vn.vineyard.id)).toEqual([
			"gc-shared",
		]);
		expect(tree[0].villages[1].vineyards.map((vn) => vn.vineyard.id)).toEqual([
			"gc-shared",
		]);
	});

	it("個別クリマ(parentAopId)は親畑の下に入れ子で並ぶ", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "gc-1", kind: "vineyard", villageAopIds: ["village-1"] }),
			aop({ id: "climat-a", kind: "vineyard", parentAopId: "gc-1" }),
			aop({ id: "climat-b", kind: "vineyard", parentAopId: "gc-1" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		const vNode = tree[0].villages[0].vineyards[0];
		expect(vNode.vineyard.id).toBe("gc-1");
		expect(vNode.climats.map((c) => c.id)).toEqual(["climat-a", "climat-b"]);
		// クリマは村直下の畑としては現れない
		expect(tree[0].villages[0].vineyards.map((vn) => vn.vineyard.id)).toEqual([
			"gc-1",
		]);
	});

	it("複数村にまたがる親畑のクリマは各村の下に現れる", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "village-2", kind: "village" }),
			aop({
				id: "gc-shared",
				kind: "vineyard",
				villageAopIds: ["village-1", "village-2"],
			}),
			aop({ id: "climat-x", kind: "vineyard", parentAopId: "gc-shared" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].villages[0].vineyards[0].climats.map((c) => c.id)).toEqual([
			"climat-x",
		]);
		expect(tree[0].villages[1].vineyards[0].climats.map((c) => c.id)).toEqual([
			"climat-x",
		]);
	});

	it("親畑がリストに無いクリマはフォールバック置き場に入る", () => {
		const aops = [
			aop({ id: "climat-orphan", kind: "vineyard", parentAopId: "missing-gc" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].unassignedVineyards.map((a) => a.id)).toEqual([
			"climat-orphan",
		]);
	});

	it("親村がリストに含まれない場合はフォールバック置き場に入る", () => {
		// 区分フィルタで村が除外されたケース。畑が消えてはいけない
		const aops = [
			aop({
				id: "gc-orphan",
				kind: "vineyard",
				villageAopIds: ["village-filtered-out"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].unassignedVineyards.map((a) => a.id)).toEqual(["gc-orphan"]);
	});

	it("シャトー(winery)は親AOCの下に格付け順で並ぶ", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({
				id: "ch-5th",
				kind: "winery",
				villageAopIds: ["village-1"],
				tags: ["cinquieme-cru-classe-1855"],
			}),
			aop({
				id: "ch-1st",
				kind: "winery",
				villageAopIds: ["village-1"],
				tags: ["premier-cru-classe-1855"],
			}),
			aop({
				id: "ch-2nd",
				kind: "winery",
				villageAopIds: ["village-1"],
				tags: ["deuxieme-cru-classe-1855"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].villages[0].vineyards).toEqual([]);
		expect(tree[0].villages[0].wineries.map((a) => a.id)).toEqual([
			"ch-1st",
			"ch-2nd",
			"ch-5th",
		]);
	});

	it("親AOCがリストに無いシャトーはフォールバック置き場に入る", () => {
		const aops = [
			aop({
				id: "ch-orphan",
				kind: "winery",
				villageAopIds: ["village-filtered-out"],
				tags: ["premier-cru-classe-1855"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].unassignedWineries.map((a) => a.id)).toEqual(["ch-orphan"]);
	});

	it("地区AOC(regional)に属するシャトーは地区ノードの下に並ぶ", () => {
		// オー・メドックのように、シャトーの親が村名でなく地区AOCのケース
		const aops = [
			aop({ id: "district-1", kind: "regional" }),
			aop({ id: "village-1", kind: "village" }),
			aop({
				id: "ch-in-district",
				kind: "winery",
				villageAopIds: ["district-1"],
				tags: ["cinquieme-cru-classe-1855"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		// 子を持つ地区AOCは親ノード化し、フラットな regionalAops には残らない
		expect(tree[0].regionalAops.map((a) => a.id)).toEqual([]);
		const districtNode = tree[0].villages.find(
			(v) => v.village.id === "district-1",
		);
		expect(districtNode?.wineries.map((a) => a.id)).toEqual(["ch-in-district"]);
	});

	it("子を持たない地区AOC(regional)はフラットな地方名AOC行に残る", () => {
		const aops = [
			aop({ id: "district-empty", kind: "regional" }),
			aop({ id: "village-1", kind: "village" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].regionalAops.map((a) => a.id)).toEqual(["district-empty"]);
		expect(tree[0].villages.map((v) => v.village.id)).toEqual(["village-1"]);
	});

	it.each([
		"bourgogne",
		"champagne",
		"bordeaux",
		"piemonte",
	])("実データ: %s の全AOPがツリーのどこかに1回以上現れる", (regionId) => {
		const region = getRegion(regionId);
		if (!region) throw new Error(`${regionId} not found`);
		const aops = listAops({ regionId: region.id });
		const tree = buildAopTree(aops, region.subregions);
		const seen = new Set<string>();
		for (const section of tree) {
			for (const a of section.regionalAops) seen.add(a.id);
			for (const v of section.villages) {
				seen.add(v.village.id);
				for (const vy of v.vineyards) {
					seen.add(vy.vineyard.id);
					for (const c of vy.climats) seen.add(c.id);
				}
				for (const w of v.wineries) seen.add(w.id);
			}
			for (const a of section.unassignedVineyards) seen.add(a.id);
			for (const a of section.unassignedWineries) seen.add(a.id);
		}
		for (const a of aops) {
			expect(seen.has(a.id), a.id).toBe(true);
		}
	});

	it("実データ: モンラシェはピュリニーとシャサーニュの両方に現れる", () => {
		const region = getRegion("bourgogne");
		if (!region) throw new Error("bourgogne not found");
		const tree = buildAopTree(
			AOPS.filter((a) => a.region === "bourgogne"),
			region.subregions,
		);
		const beaune = tree.find((s) => s.subregion.id === "cote-de-beaune");
		const parents = beaune?.villages
			.filter((v) => v.vineyards.some((vy) => vy.vineyard.id === "montrachet"))
			.map((v) => v.village.id);
		expect(parents).toEqual(["chassagne-montrachet", "puligny-montrachet"]);
	});
});

describe("flattenAopTree", () => {
	it("AopTreeListの表示順(地方名AOC→村→畑→シャトー)でフラット化する", () => {
		const aops = [
			aop({ id: "regional-1", kind: "regional" }),
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "gc-1", kind: "vineyard", villageAopIds: ["village-1"] }),
			aop({
				id: "ch-1",
				kind: "winery",
				villageAopIds: ["village-1"],
				tags: ["premier-cru-classe-1855"],
			}),
			aop({ id: "village-2", kind: "village", subregionId: "sub-b" }),
		];
		const flat = flattenAopTree(buildAopTree(aops, SUBREGIONS));
		expect(flat.map((a) => a.id)).toEqual([
			"regional-1",
			"village-1",
			"gc-1",
			"ch-1",
			"village-2",
		]);
	});

	it("複数村にまたがる畑はid重複を排除し初出のみ残す", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "village-2", kind: "village" }),
			aop({
				id: "gc-shared",
				kind: "vineyard",
				villageAopIds: ["village-1", "village-2"],
			}),
		];
		const flat = flattenAopTree(buildAopTree(aops, SUBREGIONS));
		expect(flat.map((a) => a.id)).toEqual([
			"village-1",
			"gc-shared",
			"village-2",
		]);
	});

	it("実データ: フラット化結果は全AOPを1回ずつ含む", () => {
		const region = getRegion("bourgogne");
		if (!region) throw new Error("bourgogne not found");
		const aops = listAops({ regionId: "bourgogne" });
		const flat = flattenAopTree(buildAopTree(aops, region.subregions));
		const ids = flat.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids)).toEqual(new Set(aops.map((a) => a.id)));
	});
});

describe("getSameKindSiblings", () => {
	const ordered = [
		aop({ id: "regional-1", kind: "regional" }),
		aop({ id: "village-1", kind: "village" }),
		aop({ id: "gc-1", kind: "vineyard" }),
		aop({ id: "village-2", kind: "village" }),
		aop({ id: "gc-2", kind: "vineyard" }),
		aop({ id: "village-3", kind: "village" }),
	];

	it("同一区分だけを対象に前後のidを返す(区分をまたがない)", () => {
		const village2 = ordered[3];
		const s = getSameKindSiblings(ordered, village2);
		expect(s.prevId).toBe("village-1");
		expect(s.nextId).toBe("village-3");
		expect(s.index).toBe(1);
		expect(s.total).toBe(3);
	});

	it("先頭はprevId、末尾はnextIdがundefined", () => {
		const first = getSameKindSiblings(ordered, ordered[1]); // village-1
		expect(first.prevId).toBeUndefined();
		expect(first.nextId).toBe("village-2");
		const last = getSameKindSiblings(ordered, ordered[5]); // village-3
		expect(last.prevId).toBe("village-2");
		expect(last.nextId).toBeUndefined();
	});

	it("visibleAopIdsで表示中のものだけを対象にする", () => {
		const visible = new Set(["village-1", "village-3"]); // village-2 を除外
		const s = getSameKindSiblings(ordered, ordered[1], visible); // village-1
		expect(s.prevId).toBeUndefined();
		expect(s.nextId).toBe("village-3");
		expect(s.total).toBe(2);
	});

	it("選択が表示対象に含まれない場合はindex=-1で前後なし", () => {
		const visible = new Set(["village-1", "village-3"]);
		const s = getSameKindSiblings(ordered, ordered[3], visible); // village-2(除外)
		expect(s.index).toBe(-1);
		expect(s.prevId).toBeUndefined();
		expect(s.nextId).toBeUndefined();
	});

	it("クリマは同じ親のクリマ同士でグループ化し、トップ畑と混ざらない", () => {
		const withClimats = [
			aop({ id: "gc-a", kind: "vineyard" }), // トップ畑
			aop({ id: "gc-a-1", kind: "vineyard", parentAopId: "gc-a" }),
			aop({ id: "gc-a-2", kind: "vineyard", parentAopId: "gc-a" }),
			aop({ id: "gc-b", kind: "vineyard" }), // トップ畑
			aop({ id: "gc-b-1", kind: "vineyard", parentAopId: "gc-b" }),
		];
		// gc-a-1 の兄弟は gc-a の子だけ(トップ畑や別親の子は含めない)
		const climat = getSameKindSiblings(withClimats, withClimats[1]);
		expect(climat.prevId).toBeUndefined();
		expect(climat.nextId).toBe("gc-a-2");
		expect(climat.total).toBe(2);
		// トップ畑同士は別グループ
		const top = getSameKindSiblings(withClimats, withClimats[0]);
		expect(top.nextId).toBe("gc-b");
		expect(top.total).toBe(2);
	});
});

describe("getAopAncestry", () => {
	const region: Region = {
		id: "bourgogne",
		nameJa: "ブルゴーニュ",
		nameLocal: "Bourgogne",
		country: "France",
		countryJa: "フランス",
		enabled: true,
		subregions: [
			{ id: "sub-a", nameJa: "地区A" },
			{ id: "bourgogne-regional", nameJa: "地方名AOC(広域)" },
		],
		description: "-",
	};

	it("畑は親の村名AOC・地区・地方を返す", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({
				id: "gc-1",
				kind: "vineyard",
				villageAopIds: ["village-1"],
			}),
		];
		const ancestry = getAopAncestry(aops[1], aops, region);
		expect(ancestry.regionNameJa).toBe("ブルゴーニュ");
		expect(ancestry.subregionNameJa).toBe("地区A");
		expect(ancestry.villages.map((v) => v.id)).toEqual(["village-1"]);
	});

	it("複数村にまたがる畑は複数の親村を villageAopIds 順で返す", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "village-2", kind: "village" }),
			aop({
				id: "gc-shared",
				kind: "vineyard",
				villageAopIds: ["village-2", "village-1"],
			}),
		];
		const ancestry = getAopAncestry(aops[2], aops, region);
		expect(ancestry.villages.map((v) => v.id)).toEqual([
			"village-2",
			"village-1",
		]);
	});

	it("参照先の村がリストに無い場合は取り除く", () => {
		const orphan = aop({
			id: "gc-orphan",
			kind: "vineyard",
			villageAopIds: ["missing"],
		});
		const ancestry = getAopAncestry(orphan, [orphan], region);
		expect(ancestry.villages).toEqual([]);
	});

	it("村名AOCは親村を持たず地区・地方のみ返す", () => {
		const village = aop({ id: "village-1", kind: "village" });
		const ancestry = getAopAncestry(village, [village], region);
		expect(ancestry.villages).toEqual([]);
		expect(ancestry.subregionNameJa).toBe("地区A");
	});

	it("地方名AOC(広域)は地区を持たない(合成の器のため)", () => {
		const regional = aop({
			id: "regional-1",
			kind: "regional",
			subregionId: "bourgogne-regional",
		});
		const ancestry = getAopAncestry(regional, [regional], region);
		expect(ancestry.subregionNameJa).toBeUndefined();
		expect(ancestry.regionNameJa).toBe("ブルゴーニュ");
	});

	it("クリマは親畑(parentVineyard)と、親畑経由の村を返す", () => {
		const aops = [
			aop({ id: "village-1", kind: "village" }),
			aop({ id: "gc-1", kind: "vineyard", villageAopIds: ["village-1"] }),
			aop({ id: "climat-1", kind: "vineyard", parentAopId: "gc-1" }),
		];
		const ancestry = getAopAncestry(aops[2], aops, region);
		expect(ancestry.parentVineyard?.id).toBe("gc-1");
		// 村は親畑の villageAopIds から導出する
		expect(ancestry.villages.map((v) => v.id)).toEqual(["village-1"]);
		expect(ancestry.subregionNameJa).toBe("地区A");
	});

	it("実データ: モンラシェはピュリニーとシャサーニュを親に持つ", () => {
		const bourgogne = getRegion("bourgogne");
		if (!bourgogne) throw new Error("bourgogne not found");
		const aops = listAops({ regionId: "bourgogne" });
		const montrachet = aops.find((a) => a.id === "montrachet");
		if (!montrachet) throw new Error("montrachet not found");
		const ancestry = getAopAncestry(montrachet, aops, bourgogne);
		expect(ancestry.villages.map((v) => v.id).sort()).toEqual([
			"chassagne-montrachet",
			"puligny-montrachet",
		]);
	});
});
