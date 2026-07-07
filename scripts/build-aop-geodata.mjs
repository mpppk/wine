#!/usr/bin/env node
// 地域ごとのAOP境界GeoJSON(public/data/aop/<region>.geojson)を生成する。
//
//   bun run build:geodata                # ダウンロード(キャッシュあり)から一括実行
//   bun run build:geodata -- --source /path/to/dir-or.shp   # 区画Shapefileを指定
//
// データソース(いずれも公式オープンデータ):
//  - 村名/グラン・クリュ: INAO「Délimitation parcellaire des AOC viticoles」
//    (data.gouv.fr, 区画レベルのShapefile約270MB)を id_app で抽出し、AOC単位に結合
//  - 広域(regional)AOC: INAO「Aires géographiques des AOC/AOP」CSV(コミューン一覧)
//    × geo.api.gouv.fr のコミューン輪郭ポリゴン。区画データだと数万の飛び地で
//    肥大化するため、生産地域(aire géographique)をコミューン単位で表現する
//
// 落とし穴(ハマったら読む):
//  - 中間結果をShapefileに書き出さない。パーツ数の多いMultiPolygonが壊れる。
//  - `-dissolve2`/`-clean` はレイヤー全体をモザイク化し、AOC間の重複領域を
//    1グループにしか割り当てない。グラン・クリュは村名AOCの区画に内包されて
//    いるため丸ごと消える。必ず `-split id_app` でAOCごとに分けてから
//    個別に dissolve2 し、`-merge-layers` で戻すこと。
//
// メタデータ(src/lib/wine/aops.json)が真実の源: 対象AOC(idApp)と
// classification はそこから読む。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mapshaper from "mapshaper";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".cache", "aop-geodata");
const OUT_DIR = path.join(ROOT, "public", "data", "aop");

const PARCEL_ZIP_URL =
	"https://static.data.gouv.fr/resources/delimitation-parcellaire-des-aoc-viticoles-de-linao/20260629-213846/2026-06-29-delim-parcellaire-aoc-shp.zip";
const AIRES_CSV_URL =
	"https://static.data.gouv.fr/resources/aires-geographiques-des-aoc-aop/20251009-122320/2025-10-09-comagri-communes-aires-ao.csv";
/** aire géographique CSV上の名称 → aops.json の name の対応 */
const AIRES_CSV_NAME_BY_APP = {
	Bourgogne: "Bourgogne",
	"Bourgogne aligoté": "Bourgogne aligoté",
	"Bourgogne mousseux": "Bourgogne mousseux",
	"Bourgogne Passe-tout-grains": "Bourgogne Passe-tout-grains",
	"Coteaux Bourguignons ou Bourgogne grand ordinaire ou Bourgogne ordinaire":
		"Coteaux Bourguignons",
	"Crémant de Bourgogne": "Crémant de Bourgogne",
	Mâcon: "Mâcon",
	Beaujolais: "Beaujolais",
};
/** コミューン輪郭を取得する県コード(対象AOCのINSEEコードから決まる) */
const DEPARTMENTS = ["21", "69", "71", "89"];

// 簡略化の許容誤差(m)と除去する飛び地の最小面積(m²)。
// detail は最小のグラン・クリュ(ラ・ロマネ 約0.85ha)が残る値にする。
const DETAIL_SIMPLIFY_M = 20;
const DETAIL_MIN_ISLAND_M2 = 2000;
const REGIONAL_SIMPLIFY_M = 50;

const CLASSIFICATION_RANK = { regional: 0, village: 1, "grand-cru": 2 };

async function main() {
	const sourceArg = process.argv.indexOf("--source");
	const source =
		sourceArg !== -1 ? process.argv[sourceArg + 1] : await ensureParcelDataset();
	const shp = resolveShp(source);
	console.log(`parcel shapefile: ${shp}`);

	const aops = JSON.parse(
		fs.readFileSync(path.join(ROOT, "src/lib/wine/aops.json"), "utf8"),
	);
	const byRegion = new Map();
	for (const aop of aops) {
		if (!byRegion.has(aop.region)) byRegion.set(aop.region, []);
		byRegion.get(aop.region).push(aop);
	}

	const communeFeatures = await loadCommuneContours();
	const communesByApp = await loadAiresCsv();

	fs.mkdirSync(OUT_DIR, { recursive: true });
	const boundsByRegion = {};

	for (const [region, regionAops] of byRegion) {
		const detailAops = regionAops.filter(
			(a) => a.classification !== "regional",
		);
		const regionalAops = regionAops.filter(
			(a) => a.classification === "regional",
		);
		const features = [];

		if (detailAops.length > 0) {
			features.push(
				...(await buildDetailFeatures(shp, region, detailAops)),
			);
		}
		if (regionalAops.length > 0) {
			features.push(
				...(await buildRegionalFeatures(
					region,
					regionalAops,
					communesByApp,
					communeFeatures,
				)),
			);
		}

		// メタデータをプロパティに結合し、決定的な並び(idApp昇順)で出力
		const metaByIdApp = new Map(regionAops.map((a) => [a.idApp, a]));
		features.sort((a, b) => a.properties.id_app - b.properties.id_app);
		for (const f of features) {
			if (!f.geometry) {
				throw new Error(
					`[${region}] null geometry: id_app=${f.properties.id_app}`,
				);
			}
			const meta = metaByIdApp.get(f.properties.id_app);
			if (!meta) {
				throw new Error(
					`[${region}] no metadata for id_app=${f.properties.id_app}`,
				);
			}
			f.properties = {
				idApp: meta.idApp,
				aopId: meta.id,
				name: meta.shortName,
				nameJa: meta.nameJa,
				classification: meta.classification,
				rank: CLASSIFICATION_RANK[meta.classification],
			};
		}
		const found = new Set(features.map((f) => f.properties.idApp));
		const absent = regionAops.filter((a) => !found.has(a.idApp));
		if (absent.length) {
			throw new Error(
				`[${region}] missing geometry for: ${absent.map((a) => a.id).join(", ")}`,
			);
		}

		const geojson = { type: "FeatureCollection", features };
		const outPath = path.join(OUT_DIR, `${region}.geojson`);
		fs.writeFileSync(outPath, JSON.stringify(geojson));
		boundsByRegion[region] = computeBounds(geojson);
		const mb = (fs.statSync(outPath).size / 1e6).toFixed(2);
		console.log(
			`[${region}] wrote ${path.relative(ROOT, outPath)} (${features.length} features, ${mb}MB)`,
		);
	}

	console.log("\nbounds (src/lib/wine/regions.ts に反映):");
	for (const [region, b] of Object.entries(boundsByRegion)) {
		console.log(`  ${region}: [${b.map((v) => v.toFixed(5)).join(", ")}]`);
	}
}

/** 村名/グラン・クリュ: INAO区画データをAOC単位に結合・簡略化 */
async function buildDetailFeatures(shp, region, detailAops) {
	const ids = detailAops.map((a) => a.idApp);
	const tmpOut = path.join(CACHE_DIR, `${region}.detail.geojson`);
	console.log(
		`[${region}/detail] ${ids.length} AOCs — dissolving parcels (数分かかります)…`,
	);
	await mapshaper.runCommands(
		[
			`-i ${shp}`,
			`-filter '${JSON.stringify(ids)}.indexOf(id_app) > -1'`,
			`-split id_app`,
			`-dissolve2 target=* copy-fields=id_app,app`,
			`-merge-layers target=* force`,
			`-simplify interval=${DETAIL_SIMPLIFY_M} keep-shapes`,
			`-filter-islands min-area=${DETAIL_MIN_ISLAND_M2}`,
			`-proj wgs84`,
			`-o ${tmpOut} format=geojson precision=0.00001 force`,
		].join(" "),
	);
	return JSON.parse(fs.readFileSync(tmpOut, "utf8")).features;
}

/** 広域AOC: aire géographique(コミューン一覧)×コミューン輪郭を結合 */
async function buildRegionalFeatures(
	region,
	regionalAops,
	communesByApp,
	communeFeatures,
) {
	const inputFeatures = [];
	for (const aop of regionalAops) {
		const csvName = AIRES_CSV_NAME_BY_APP[aop.name];
		const codes = csvName ? communesByApp.get(csvName) : undefined;
		if (!codes) {
			throw new Error(`[${region}] no aire géographique for ${aop.name}`);
		}
		let missing = 0;
		for (const code of codes) {
			const f = communeFeatures.get(code);
			if (!f) {
				missing++; // コミューン合併等で現行コードに無いもの(gap-fillで穴埋め)
				continue;
			}
			inputFeatures.push({
				type: "Feature",
				properties: { id_app: aop.idApp, app: aop.name },
				geometry: f.geometry,
			});
		}
		if (missing) {
			console.log(
				`[${region}/regional] ${aop.id}: ${missing}/${codes.size} communes not found (merged INSEE codes)`,
			);
		}
	}
	const tmpIn = path.join(CACHE_DIR, `${region}.regional.input.geojson`);
	const tmpOut = path.join(CACHE_DIR, `${region}.regional.geojson`);
	fs.writeFileSync(
		tmpIn,
		JSON.stringify({ type: "FeatureCollection", features: inputFeatures }),
	);
	await mapshaper.runCommands(
		[
			`-i ${tmpIn}`,
			`-split id_app`,
			// gap-fill-area: コミューン合併でコードが引けなかった穴を埋める
			`-dissolve2 target=* copy-fields=id_app,app gap-fill-area=30km2`,
			`-merge-layers target=* force`,
			`-simplify interval=${REGIONAL_SIMPLIFY_M} keep-shapes`,
			`-o ${tmpOut} format=geojson precision=0.00001 force`,
		].join(" "),
	);
	return JSON.parse(fs.readFileSync(tmpOut, "utf8")).features;
}

async function loadCommuneContours() {
	const map = new Map();
	for (const dept of DEPARTMENTS) {
		const cached = path.join(CACHE_DIR, `communes-${dept}.geojson`);
		if (!fs.existsSync(cached)) {
			console.log(`downloading commune contours for dept ${dept}…`);
			const res = await fetch(
				`https://geo.api.gouv.fr/communes?codeDepartement=${dept}&format=geojson&geometry=contour`,
			);
			if (!res.ok) throw new Error(`geo.api.gouv.fr ${dept}: ${res.status}`);
			fs.mkdirSync(CACHE_DIR, { recursive: true });
			fs.writeFileSync(cached, await res.text());
		}
		const gj = JSON.parse(fs.readFileSync(cached, "utf8"));
		for (const f of gj.features) map.set(f.properties.code, f);
	}
	return map;
}

async function loadAiresCsv() {
	const cached = path.join(CACHE_DIR, "communes-aires-ao.csv");
	if (!fs.existsSync(cached)) {
		console.log("downloading aires géographiques CSV…");
		const res = await fetch(AIRES_CSV_URL);
		if (!res.ok) throw new Error(`aires CSV: ${res.status}`);
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
	}
	// Latin-1 / セミコロン区切り: CI;Département;Commune;Art;"Aire géographique";IDA
	const text = fs.readFileSync(cached, "latin1");
	const byName = new Map();
	for (const line of text.split("\n").slice(1)) {
		const cols = line.split(";");
		if (cols.length < 5) continue;
		const code = cols[0].trim();
		const name = cols[4].replaceAll('"', "").trim();
		if (!byName.has(name)) byName.set(name, new Set());
		byName.get(name).add(code);
	}
	return byName;
}

async function ensureParcelDataset() {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const zipPath = path.join(CACHE_DIR, "delim-parcellaire-aoc-shp.zip");
	const extractDir = path.join(CACHE_DIR, "parcellaire");
	if (!fs.existsSync(zipPath)) {
		console.log(`downloading ${PARCEL_ZIP_URL} (約270MB)…`);
		const res = await fetch(PARCEL_ZIP_URL);
		if (!res.ok) throw new Error(`download failed: ${res.status}`);
		fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
	}
	if (!fs.existsSync(extractDir)) {
		console.log("unzipping…");
		fs.mkdirSync(extractDir, { recursive: true });
		execFileSync("unzip", ["-o", "-q", zipPath, "-d", extractDir]);
	}
	return extractDir;
}

function resolveShp(source) {
	const stat = fs.statSync(source);
	if (stat.isFile()) return source;
	const shp = fs.readdirSync(source).find((f) => f.endsWith(".shp"));
	if (!shp) throw new Error(`no .shp found in ${source}`);
	return path.join(source, shp);
}

function computeBounds(geojson) {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	const visit = (coords) => {
		if (typeof coords[0] === "number") {
			if (coords[0] < west) west = coords[0];
			if (coords[0] > east) east = coords[0];
			if (coords[1] < south) south = coords[1];
			if (coords[1] > north) north = coords[1];
			return;
		}
		for (const c of coords) visit(c);
	};
	for (const f of geojson.features) visit(f.geometry.coordinates);
	return [west, south, east, north];
}

await main();
