import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AOPS } from "./aops-data";
import { REGIONS } from "./regions";

// aops.json と public/data/aop/*.geojson の整合性を検証する。
// (aops.json のスキーマ検証自体は aops-data.ts の読み込み時に行われる)

describe("AOPメタデータの整合性", () => {
	it("スラッグとidAppが一意", () => {
		const ids = AOPS.map((a) => a.id);
		const idApps = AOPS.map((a) => a.idApp);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(idApps).size).toBe(idApps.length);
	});

	it("regionとsubregionIdが地域マスタに存在する", () => {
		for (const aop of AOPS) {
			const region = REGIONS.find((r) => r.id === aop.region);
			expect(region, `region ${aop.region} (${aop.id})`).toBeDefined();
			expect(
				region?.subregions.some((s) => s.id === aop.subregionId),
				`subregion ${aop.subregionId} (${aop.id})`,
			).toBe(true);
		}
	});

	it("特級と一級のタグを同時に持つAOPがない", () => {
		for (const aop of AOPS) {
			const tags = aop.tags ?? [];
			expect(
				tags.includes("grand-cru") && tags.includes("premier-cru"),
				aop.id,
			).toBe(false);
		}
	});

	it("畑(vineyard)の親村参照が有効", () => {
		const byId = new Map(AOPS.map((a) => [a.id, a]));
		for (const aop of AOPS.filter((a) => a.kind === "vineyard")) {
			expect(aop.villageAopIds?.length, aop.id).toBeGreaterThan(0);
			for (const villageId of aop.villageAopIds ?? []) {
				const village = byId.get(villageId);
				expect(village, `${aop.id} -> ${villageId}`).toBeDefined();
				expect(village?.kind, `${aop.id} -> ${villageId}`).toBe("village");
				expect(village?.region, `${aop.id} -> ${villageId}`).toBe(aop.region);
			}
		}
	});

	it("villageAopIds は畑(vineyard)のみが持つ", () => {
		for (const aop of AOPS.filter((a) => a.kind !== "vineyard")) {
			expect(aop.villageAopIds, aop.id).toBeUndefined();
		}
	});

	it("移行後の件数スナップショット(区分・タグ)", () => {
		// 旧 classification/premierCru からの移行が欠落なく行われたことの回帰チェック
		const vineyards = AOPS.filter((a) => a.kind === "vineyard");
		expect(vineyards.length).toBe(33);
		expect(vineyards.every((a) => a.region === "bourgogne")).toBe(true);
		expect(AOPS.filter((a) => a.tags?.includes("grand-cru")).length).toBe(50);
		expect(AOPS.filter((a) => a.tags?.includes("premier-cru")).length).toBe(73);
		expect(AOPS.filter((a) => a.kind === "winery").length).toBe(0);
	});

	it("主要品種(principal)が少なくとも1つある", () => {
		for (const aop of AOPS) {
			expect(
				aop.grapes.some((g) => g.role === "principal"),
				aop.id,
			).toBe(true);
		}
	});
});

describe("GeoJSONとの整合性", () => {
	const enabledRegions = REGIONS.filter((r) => r.enabled);

	it.each(
		enabledRegions.map((r) => [r.id, r] as const),
	)("%s: GeoJSONが存在しメタデータと1:1で結合できる", (_id, region) => {
		const geojsonPath = path.join(
			process.cwd(),
			"public",
			region.geojsonPath ?? "",
		);
		expect(fs.existsSync(geojsonPath), geojsonPath).toBe(true);

		const geojson = JSON.parse(fs.readFileSync(geojsonPath, "utf8")) as {
			features: {
				properties: {
					idApp: number;
					aopId: string;
					kind: string;
					tags: string[];
					rank: number;
				};
			}[];
		};
		const regionAops = AOPS.filter((a) => a.region === region.id);
		expect(geojson.features.length).toBe(regionAops.length);

		const byIdApp = new Map(regionAops.map((a) => [a.idApp, a]));
		for (const f of geojson.features) {
			const meta = byIdApp.get(f.properties.idApp);
			expect(meta, `idApp ${f.properties.idApp}`).toBeDefined();
			expect(f.properties.aopId).toBe(meta?.id);
			expect(f.properties.kind).toBe(meta?.kind);
			expect(f.properties.tags).toEqual(meta?.tags ?? []);
			expect(f.properties.rank).toBe(
				{ regional: 0, village: 1, vineyard: 2, winery: 3 }[
					meta?.kind ?? "village"
				],
			);
		}
	});
});
