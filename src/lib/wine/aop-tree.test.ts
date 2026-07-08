import { describe, expect, it } from "vitest";
import { buildAopTree, getAopAncestry } from "./aop-tree";
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
		producers: ["-"],
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
		expect(tree[0].villages[0].vineyards.map((a) => a.id)).toEqual(["gc-1"]);
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
		expect(tree[0].villages[0].vineyards.map((a) => a.id)).toEqual([
			"gc-shared",
		]);
		expect(tree[0].villages[1].vineyards.map((a) => a.id)).toEqual([
			"gc-shared",
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

	it.each([
		"bourgogne",
		"champagne",
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
				for (const vy of v.vineyards) seen.add(vy.id);
			}
			for (const a of section.unassignedVineyards) seen.add(a.id);
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
			.filter((v) => v.vineyards.some((vy) => vy.id === "montrachet"))
			.map((v) => v.village.id);
		expect(parents).toEqual(["chassagne-montrachet", "puligny-montrachet"]);
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
