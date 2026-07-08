import { describe, expect, it } from "vitest";
import { buildAopTree } from "./aop-tree";
import { AOPS } from "./aops-data";
import { getRegion, listAops } from "./service";
import type { Aop, Subregion } from "./types";

function aop(partial: Partial<Aop> & Pick<Aop, "id" | "classification">): Aop {
	return {
		idApp: 1,
		name: partial.id,
		shortName: partial.id,
		nameJa: partial.id,
		region: "bourgogne",
		subregionId: "sub-a",
		premierCru: false,
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
	it("地区ごとに地方名AOC・村・グラン・クリュを階層化する", () => {
		const aops = [
			aop({ id: "regional-1", classification: "regional" }),
			aop({ id: "village-1", classification: "village" }),
			aop({
				id: "gc-1",
				classification: "grand-cru",
				villageAopIds: ["village-1"],
			}),
			aop({ id: "village-2", classification: "village", subregionId: "sub-b" }),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree).toHaveLength(2);
		expect(tree[0].regionalAops.map((a) => a.id)).toEqual(["regional-1"]);
		expect(tree[0].villages.map((v) => v.village.id)).toEqual(["village-1"]);
		expect(tree[0].villages[0].grandCrus.map((a) => a.id)).toEqual(["gc-1"]);
		expect(tree[1].villages.map((v) => v.village.id)).toEqual(["village-2"]);
	});

	it("複数村にまたがるグラン・クリュは各村の下に重複して現れる", () => {
		const aops = [
			aop({ id: "village-1", classification: "village" }),
			aop({ id: "village-2", classification: "village" }),
			aop({
				id: "gc-shared",
				classification: "grand-cru",
				villageAopIds: ["village-1", "village-2"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].villages[0].grandCrus.map((a) => a.id)).toEqual([
			"gc-shared",
		]);
		expect(tree[0].villages[1].grandCrus.map((a) => a.id)).toEqual([
			"gc-shared",
		]);
	});

	it("親村がリストに含まれない場合はフォールバック置き場に入る", () => {
		// 格付けフィルタで村が除外されたケース。グラン・クリュが消えてはいけない
		const aops = [
			aop({
				id: "gc-orphan",
				classification: "grand-cru",
				villageAopIds: ["village-filtered-out"],
			}),
		];
		const tree = buildAopTree(aops, SUBREGIONS);
		expect(tree[0].unassignedGrandCrus.map((a) => a.id)).toEqual(["gc-orphan"]);
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
				for (const gc of v.grandCrus) seen.add(gc.id);
			}
			for (const a of section.unassignedGrandCrus) seen.add(a.id);
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
			.filter((v) => v.grandCrus.some((gc) => gc.id === "montrachet"))
			.map((v) => v.village.id);
		expect(parents).toEqual(["chassagne-montrachet", "puligny-montrachet"]);
	});
});
