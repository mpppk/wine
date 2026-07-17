import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AOPS } from "./aops-data";
import { MICHELIN_GRAPES_ARTICLE_URL, PRODUCER_INFO } from "./producer-info";
import { REGIONS } from "./regions";
import { POLYGONLESS_IDAPP_MIN } from "./types";

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

	it("1つのAOPは格付けタグを高々1つしか持たない", () => {
		// 制度が異なっても、格付けは1AOPにつき1つ(特級かつ一級のような併持は無い)
		for (const aop of AOPS) {
			expect((aop.tags ?? []).length, aop.id).toBeLessThanOrEqual(1);
		}
	});

	it("畑・シャトーの親AOC参照が有効", () => {
		const byId = new Map(AOPS.map((a) => [a.id, a]));
		// 村名AOCを持つ地域では畑は必ず親村を参照する。アルザスのように
		// 村名AOC自体が存在しない地域の畑は villageAopIds を持たない。
		const regionsWithVillages = new Set(
			AOPS.filter((a) => a.kind === "village").map((a) => a.region),
		);
		// 個別クリマ(parentAopId を持つ畑)は親畑を参照し、村は親から導出するため
		// villageAopIds を持たない。トップレベルの畑だけが村を参照する。
		for (const aop of AOPS.filter(
			(a) => a.kind === "vineyard" && a.parentAopId,
		)) {
			expect(aop.villageAopIds, aop.id).toBeUndefined();
			const parent = aop.parentAopId ? byId.get(aop.parentAopId) : undefined;
			expect(parent, `${aop.id} -> ${aop.parentAopId}`).toBeDefined();
			expect(parent?.kind, `${aop.id} -> ${aop.parentAopId}`).toBe("vineyard");
			expect(parent?.region, `${aop.id} -> ${aop.parentAopId}`).toBe(
				aop.region,
			);
		}
		for (const aop of AOPS.filter(
			(a) => a.kind === "vineyard" && !a.parentAopId,
		)) {
			if (regionsWithVillages.has(aop.region)) {
				expect(aop.villageAopIds?.length, aop.id).toBeGreaterThan(0);
			} else {
				expect(aop.villageAopIds, aop.id).toBeUndefined();
			}
			for (const villageId of aop.villageAopIds ?? []) {
				const village = byId.get(villageId);
				expect(village, `${aop.id} -> ${villageId}`).toBeDefined();
				expect(village?.kind, `${aop.id} -> ${villageId}`).toBe("village");
				expect(village?.region, `${aop.id} -> ${villageId}`).toBe(aop.region);
			}
		}
		// シャトーはちょうど1つの親を持つ。親は村名AOCまたは地区AOC(オー・メドック等)
		for (const aop of AOPS.filter((a) => a.kind === "winery")) {
			expect(aop.villageAopIds?.length, aop.id).toBe(1);
			const parentId = aop.villageAopIds?.[0];
			const parent = parentId ? byId.get(parentId) : undefined;
			expect(parent, `${aop.id} -> ${parentId}`).toBeDefined();
			expect(["village", "regional"], `${aop.id} -> ${parentId}`).toContain(
				parent?.kind,
			);
			expect(parent?.region, `${aop.id} -> ${parentId}`).toBe(aop.region);
		}
	});

	it("villageAopIds は畑(vineyard)とシャトー(winery)のみが持つ", () => {
		for (const aop of AOPS.filter(
			(a) => a.kind !== "vineyard" && a.kind !== "winery",
		)) {
			expect(aop.villageAopIds, aop.id).toBeUndefined();
		}
	});

	it("移行後の件数スナップショット(区分・タグ)", () => {
		// 旧 classification/premierCru からの移行が欠落なく行われたことの回帰チェック。
		// 個別クリマ(Chablis GC 7 + Chablis 1er 17 + Corton 8)と合成総称ノード
		// (Chablis Premier Cru)を畑として追加したぶん、件数を更新している。
		const vineyards = AOPS.filter((a) => a.kind === "vineyard");
		expect(vineyards.length).toBe(117);
		expect(vineyards.filter((a) => a.region === "bourgogne").length).toBe(66);
		expect(vineyards.filter((a) => a.region === "alsace").length).toBe(51);
		expect(AOPS.filter((a) => a.tags?.includes("grand-cru")).length).toBe(116);
		expect(AOPS.filter((a) => a.tags?.includes("premier-cru")).length).toBe(91);
	});

	it("個別クリマ/合成総称ノードはポリゴンを持たない帯(idApp>=930000)にある", () => {
		// ジオメトリ/重心の生成・整合チェックはこの帯を対象外にする(下記GeoJSONテスト)
		for (const aop of AOPS.filter((a) => a.parentAopId)) {
			expect(aop.idApp, aop.id).toBeGreaterThanOrEqual(POLYGONLESS_IDAPP_MIN);
			expect(aop.isAppellation, aop.id).toBe(false);
		}
	});

	it("ボルドー: シャトー(winery)の件数と格付けの内訳", () => {
		const wineries = AOPS.filter((a) => a.kind === "winery");
		expect(wineries.length).toBe(102);
		expect(wineries.every((a) => a.region === "bordeaux")).toBe(true);
		const countTag = (t: string) =>
			AOPS.filter((a) => a.tags?.includes(t as never)).length;
		// メドック1855: 1級5+ソーテルヌ1級11=16 / 2級14+15=29 / 3級14 / 4級10 / 5級18
		expect(countTag("premier-cru-superieur-1855")).toBe(1); // イケム
		expect(countTag("premier-cru-classe-1855")).toBe(16);
		expect(countTag("deuxieme-cru-classe-1855")).toBe(29);
		expect(countTag("troisieme-cru-classe-1855")).toBe(14);
		expect(countTag("quatrieme-cru-classe-1855")).toBe(10);
		expect(countTag("cinquieme-cru-classe-1855")).toBe(18);
		// サンテミリオン2022 1er GCC
		expect(countTag("premier-grand-cru-classe-a")).toBe(2);
		expect(countTag("premier-grand-cru-classe-b")).toBe(12);
	});

	it("ボルドー1855/サンテミリオン格付けタグは winery のみが持つ", () => {
		const wineryTags = new Set([
			"premier-cru-superieur-1855",
			"premier-cru-classe-1855",
			"deuxieme-cru-classe-1855",
			"troisieme-cru-classe-1855",
			"quatrieme-cru-classe-1855",
			"cinquieme-cru-classe-1855",
			"premier-grand-cru-classe-a",
			"premier-grand-cru-classe-b",
		]);
		for (const aop of AOPS) {
			if ((aop.tags ?? []).some((t) => wineryTags.has(t))) {
				expect(aop.kind, aop.id).toBe("winery");
			}
		}
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

describe("生産者情報(PRODUCER_INFO)の整合性", () => {
	// 全AOPに登場する生産者名の集合。PRODUCER_INFO のキーはここに含まれていないと
	// ダイアログで表示されず、表記ゆれの温床になるため参照整合性を検証する。
	const producerNames = new Set(
		AOPS.flatMap((a) => a.producers.map((p) => p.name)),
	);

	it("PRODUCER_INFO のキーは aops.json の生産者名に存在する", () => {
		for (const name of Object.keys(PRODUCER_INFO)) {
			expect(producerNames.has(name), name).toBe(true);
		}
	});

	it("各エントリは説明文を持ち、公式サイトは有効なURL", () => {
		for (const [name, info] of Object.entries(PRODUCER_INFO)) {
			expect(info.description.length, name).toBeGreaterThan(0);
			if (info.officialWebsite !== undefined) {
				expect(
					() => new URL(info.officialWebsite as string),
					name,
				).not.toThrow();
				expect(info.officialWebsite, name).toMatch(/^https?:\/\//);
			}
		}
	});

	it("MICHELIN Grapes 記事URLは michelin.com の有効な https URL", () => {
		expect(() => new URL(MICHELIN_GRAPES_ARTICLE_URL)).not.toThrow();
		const url = new URL(MICHELIN_GRAPES_ARTICLE_URL);
		expect(url.protocol).toBe("https:");
		expect(url.hostname).toMatch(/(^|\.)michelin\.com$/);
	});
});

describe("ピエモンテ(イタリア)の整合性", () => {
	const piemonte = AOPS.filter((a) => a.region === "piemonte");

	it("件数スナップショット(DOCG18 / DOC11 / 計29)", () => {
		expect(piemonte.length).toBe(29);
		expect(piemonte.filter((a) => a.tags?.includes("docg")).length).toBe(18);
		expect(piemonte.filter((a) => a.tags?.includes("doc")).length).toBe(11);
	});

	it("各レコードは docg / doc のちょうど一方を持つ", () => {
		for (const aop of piemonte) {
			const tags = aop.tags ?? [];
			const n = Number(tags.includes("docg")) + Number(tags.includes("doc"));
			expect(n, aop.id).toBe(1);
		}
	});

	it("docg / doc タグはピエモンテ以外に付かない", () => {
		for (const aop of AOPS.filter((a) => a.region !== "piemonte")) {
			const tags = aop.tags ?? [];
			expect(tags.includes("docg") || tags.includes("doc"), aop.id).toBe(false);
		}
	});

	it("区分は regional / village のみ(畑・ワイナリーは無し)", () => {
		for (const aop of piemonte) {
			expect(["regional", "village"]).toContain(aop.kind);
		}
	});
});

describe("境界GeoJSON(<region>-boundaries.geojson)の整合性", () => {
	const enabledRegions = REGIONS.filter((r) => r.enabled);

	it.each(
		enabledRegions.map((r) => [r.id, r] as const),
	)("%s: 境界GeoJSONが存在し地方1つ+有効な地区で構成される", (_id, region) => {
		const boundariesPath = path.join(
			process.cwd(),
			"public",
			region.boundariesPath ?? "",
		);
		expect(fs.existsSync(boundariesPath), boundariesPath).toBe(true);

		const geojson = JSON.parse(fs.readFileSync(boundariesPath, "utf8")) as {
			features: {
				geometry: { type: string };
				properties: {
					level: string;
					regionId?: string;
					subregionId?: string;
					nameJa: string;
				};
			}[];
		};

		// 地方(level=region)はちょうど1つで、regionId が一致する
		const regionFeatures = geojson.features.filter(
			(f) => f.properties.level === "region",
		);
		expect(regionFeatures.length).toBe(1);
		expect(regionFeatures[0].properties.regionId).toBe(region.id);

		// 地区(level=subregion)は地域マスタの地理的地区(`*-regional` 以外)の
		// サブセット。収録AOPが無い地区(cote-de-sezanne 等)は欠けてよい
		const geographicIds = new Set(
			region.subregions
				.filter((s) => !s.id.endsWith("-regional"))
				.map((s) => s.id),
		);
		const subregionFeatures = geojson.features.filter(
			(f) => f.properties.level === "subregion",
		);
		const seen = new Set<string>();
		for (const f of subregionFeatures) {
			const id = f.properties.subregionId ?? "";
			expect(geographicIds.has(id), `${region.id}: ${id}`).toBe(true);
			expect(seen.has(id), `${region.id}: duplicate ${id}`).toBe(false);
			seen.add(id);
		}
		expect(geojson.features.length).toBe(1 + subregionFeatures.length);

		// 全フィーチャが面で nameJa を持つ
		for (const f of geojson.features) {
			expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
			expect(f.properties.nameJa.length).toBeGreaterThan(0);
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
				geometry: { type: string };
				properties: {
					idApp: number;
					aopId: string;
					kind: string;
					tags: string[];
					rank: number;
				};
			}[];
		};
		// ポリゴンを持たない詳細エントリ(クリマ・合成総称ノード)は GeoJSON に
		// 現れないので、1:1 の対象から除外する。
		const regionAops = AOPS.filter(
			(a) => a.region === region.id && a.idApp < POLYGONLESS_IDAPP_MIN,
		);
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
			// シャトー(winery)は点、それ以外は面
			if (meta?.kind === "winery") {
				expect(f.geometry.type, meta.id).toBe("Point");
			} else {
				expect(["Polygon", "MultiPolygon"], meta?.id).toContain(
					f.geometry.type,
				);
			}
		}
	});
});
