#!/usr/bin/env node
// 地域ごとのAOP境界GeoJSON(public/data/aop/<region>.geojson)を生成する。
//
//   bun run build:geodata                       # 全地域(ダウンロード・キャッシュあり)
//   bun run build:geodata -- --region bordeaux  # 特定地域だけ再生成
//   bun run build:geodata -- --source /path/to/dir-or.shp   # 区画Shapefileを指定
//
// データソース(いずれも公式オープンデータ):
//  - 村名/畑: INAO「Délimitation parcellaire des AOC viticoles」
//    (data.gouv.fr, 区画レベルのShapefile約270MB)を id_app で抽出し、AOC単位に結合
//  - 広域(regional)AOC: INAO「Aires géographiques des AOC/AOP」CSV(コミューン一覧)
//    × geo.api.gouv.fr のコミューン輪郭ポリゴン。区画データだと数万の飛び地で
//    肥大化するため、生産地域(aire géographique)をコミューン単位で表現する
//  - 村名AOC(コミューン輪郭ベース): シャンパーニュのクリュ村・ボルドーの村名/地区AOC。
//    区画データに無い(シャンパーニュ)か、区画だと飛び地が多すぎる/隣接部分コミューンを
//    含み村同士が重なる(ボルドー)ため、COMMUNES_BY_AOP_ID の対応表で主要コミューン輪郭から
//    生成する。合併で消えた村(Aÿ/Oger/Louvois等)は geo.api.gouv.fr の委任コミューンを引く
//  - シャトー(winery): 面ではなく点。WINERY_COORDS_BY_AOP_ID の座標から Point で生成する
//    (ボルドーのシャトーはINAO区画に個別ポリゴンが無いため)
//
// 落とし穴(ハマったら読む):
//  - 中間結果をShapefileに書き出さない。パーツ数の多いMultiPolygonが壊れる。
//  - `-dissolve2`/`-clean` はレイヤー全体をモザイク化し、AOC間の重複領域を
//    1グループにしか割り当てない。グラン・クリュは村名AOCの区画に内包されて
//    いるため丸ごと消える。必ず `-split id_app` でAOCごとに分けてから
//    個別に dissolve2 し、`-merge-layers` で戻すこと。
//
// メタデータ(src/lib/wine/aops.json)が真実の源: 対象AOC(idApp)と
// kind / tags はそこから読む。
//
// 経路の選択(main()のルーティング):
//  - WINERY_COORDS_BY_AOP_ID にある      → winery(Point)経路
//  - COMMUNES_BY_AOP_ID にある            → コミューン輪郭経路
//  - kind === "regional"                 → 広域(aire géographique)経路
//  - それ以外                            → 区画(detail)経路(区画Shapefileが必要)

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
	Champagne: "Champagne",
	"Coteaux champenois": "Coteaux champenois",
	// ボルドーの広域・地区AOC(生産地域=多コミューンにまたがる)
	Bordeaux: "Bordeaux",
	"Bordeaux Supérieur": "Bordeaux supérieur",
	Médoc: "Médoc",
	"Haut-Médoc": "Haut-Médoc",
	Graves: "Graves",
	"Entre-deux-Mers": "Entre-deux-Mers",
};
/** 委任コミューン(合併で消えた旧村)の輪郭を取得する県コード */
const DELEGATED_DEPARTMENTS = ["51"];

/**
 * コミューン輪郭から境界を生成するAOP(シャンパーニュのクリュ村・ボルドーの村名AOC)の
 * aops.json の id → INSEEコードの対応表。ここにあるAOPは区画Shapefileを使わない。
 * 合併で消えた村は旧INSEEコード(委任コミューン)を指定する:
 *   Aÿ-Champagne(2016) = Aÿ 51030 + Mareuil-sur-Aÿ 51347 + Bisseuil 51064
 *   Val de Livre(2016) = Louvois 51331 + Tauxières-Mutry 51564
 *   Blancs-Coteaux(2018) = Vertus 51612 + Oger 51411 + Voipreux 51651 (+ Gionges)
 * 例外: Coligny は1968年合併の Val-des-Marais 51158(現行コード)で代用。
 *
 * ボルドーの村名AOCは生産地域(aire)だと隣接部分コミューンまで含み村同士が重なるため、
 * 中核コミューンをキュレーションする(シャンパーニュのクリュ村と同じ方針)。
 */
const COMMUNES_BY_AOP_ID = {
	// === シャンパーニュ ===
	// 実AOC(村限定)
	"rose-des-riceys": ["10317"], // Les Riceys
	// グラン・クリュ17村
	ambonnay: ["51007"],
	avize: ["51029"],
	ay: ["51030"],
	"beaumont-sur-vesle": ["51044"],
	bouzy: ["51079"],
	chouilly: ["51153"],
	cramant: ["51196"],
	louvois: ["51331"],
	"mailly-champagne": ["51338"],
	"le-mesnil-sur-oger": ["51367"],
	oger: ["51411"],
	oiry: ["51413"],
	puisieulx: ["51450"],
	sillery: ["51536"],
	"tours-sur-marne": ["51576"],
	verzenay: ["51613"],
	verzy: ["51614"],
	// プルミエ・クリュ42村
	"avenay-val-d-or": ["51028"],
	"bergeres-les-vertus": ["51049"],
	bezannes: ["51058"],
	"billy-le-grand": ["51061"],
	bisseuil: ["51064"],
	chamery: ["51112"],
	champillon: ["51119"],
	"chigny-les-roses": ["51152"],
	coligny: ["51158"],
	cormontreuil: ["51172"],
	"coulommes-la-montagne": ["51177"],
	cuis: ["51200"],
	cumieres: ["51202"],
	dizy: ["51210"],
	ecueil: ["51225"],
	etrechy: ["51239"],
	grauves: ["51281"],
	hautvillers: ["51287"],
	"jouy-les-reims": ["51310"],
	"les-mesneux": ["51365"],
	ludes: ["51333"],
	"mareuil-sur-ay": ["51347"],
	montbre: ["51375"],
	mutigny: ["51392"],
	"pargny-les-reims": ["51422"],
	pierry: ["51431"],
	"rilly-la-montagne": ["51461"],
	sacy: ["51471"],
	sermiers: ["51532"],
	taissy: ["51562"],
	"tauxieres-mutry": ["51564"],
	trepail: ["51580"],
	"trois-puits": ["51584"],
	vaudemange: ["51599"],
	vertus: ["51612"],
	"ville-dommange": ["51622"],
	"villeneuve-renneville-chevigny": ["51627"],
	"villers-allerand": ["51629"],
	"villers-aux-noeuds": ["51631"],
	"villers-marmery": ["51636"],
	voipreux: ["51651"],
	vrigny: ["51657"],
	// === ボルドー: 村名AOC(中核コミューン) ===
	// メドック(左岸)
	"saint-estephe": ["33395"],
	pauillac: ["33314"],
	"saint-julien": ["33423"], // Saint-Julien-Beychevelle
	margaux: ["33268", "33517", "33012", "33211"], // Margaux-Cantenac, Soussans, Arsac, Labarde
	"listrac-medoc": ["33248"],
	"moulis-en-medoc": ["33297"],
	// グラーヴ / ソーテルヌ
	"pessac-leognan": [
		"33238", // Léognan
		"33274", // Martillac
		"33318", // Pessac (Haut-Brion)
		"33522", // Talence
		"33080", // Cadaujac
		"33192", // Gradignan
		"33550", // Villenave-d'Ornon
		"33090", // Canéjan
		"33448", // Saint-Médard-d'Eyrans
	],
	sauternes: ["33504", "33060", "33164", "33337"], // Sauternes, Bommes, Fargues, Preignac
	barsac: ["33030"],
	// リブルネ(右岸)。saint-emilion と grand-cru は同一区域
	"saint-emilion": [
		"33394",
		"33384",
		"33396",
		"33420",
		"33426",
		"33459",
		"33480",
		"33546",
	],
	"saint-emilion-grand-cru": [
		"33394",
		"33384",
		"33396",
		"33420",
		"33426",
		"33459",
		"33480",
		"33546",
	],
	pomerol: ["33328"],
};

/**
 * シャトー(winery)の所在地座標 [経度, 緯度] (WGS84)。出典: Wikidata/OSM を手動確認。
 * ここにあるAOPは点(Point)フィーチャとして出力する。
 */
const WINERY_COORDS_BY_AOP_ID = {
	// ボルドーのシャトーは Phase 3 で投入する
};

// 簡略化の許容誤差(m)と除去する飛び地の最小面積(m²)。
// detail は最小の特級畑(ラ・ロマネ 約0.85ha)が残る値にする。
const DETAIL_SIMPLIFY_M = 20;
const DETAIL_MIN_ISLAND_M2 = 2000;
const REGIONAL_SIMPLIFY_M = 50;

const KIND_RANK = { regional: 0, village: 1, vineyard: 2, winery: 3 };

async function main() {
	const regionArg = process.argv.indexOf("--region");
	const regionFilter = regionArg !== -1 ? process.argv[regionArg + 1] : undefined;
	const sourceArg = process.argv.indexOf("--source");

	const aops = JSON.parse(
		fs.readFileSync(path.join(ROOT, "src/lib/wine/aops.json"), "utf8"),
	);
	let byRegion = new Map();
	for (const aop of aops) {
		if (!byRegion.has(aop.region)) byRegion.set(aop.region, []);
		byRegion.get(aop.region).push(aop);
	}
	if (regionFilter) {
		if (!byRegion.has(regionFilter)) {
			throw new Error(`--region ${regionFilter}: no AOPs found`);
		}
		byRegion = new Map([[regionFilter, byRegion.get(regionFilter)]]);
	}

	const builtAops = [...byRegion.values()].flat();
	const communesByApp = await loadAiresCsv();

	// 実際に参照されるINSEEコードから必要な県コードを導出し、そのぶんだけ取得する
	// (--region 指定時に他地域のコミューン輪郭をダウンロードしない)
	const neededCodes = new Set();
	for (const aop of builtAops) {
		if (COMMUNES_BY_AOP_ID[aop.id]) {
			for (const c of COMMUNES_BY_AOP_ID[aop.id]) neededCodes.add(c);
		} else if (aop.kind === "regional") {
			const codes = communesByApp.get(AIRES_CSV_NAME_BY_APP[aop.name]);
			if (codes) for (const c of codes) neededCodes.add(c);
		}
	}
	const departments = [...new Set([...neededCodes].map((c) => c.slice(0, 2)))];
	const communeFeatures = departments.length
		? await loadCommuneContours(departments)
		: new Map();
	const delegatedDepartments = departments.filter((d) =>
		DELEGATED_DEPARTMENTS.includes(d),
	);
	const delegatedFeatures = delegatedDepartments.length
		? await loadDelegatedCommuneContours(delegatedDepartments)
		: new Map();

	// 区画Shapefileは detail 経路のAOPがある場合のみ取得する(270MBのダウンロード回避)
	const needsParcels = builtAops.some(
		(a) =>
			a.kind !== "regional" &&
			!COMMUNES_BY_AOP_ID[a.id] &&
			!WINERY_COORDS_BY_AOP_ID[a.id],
	);
	let shp;
	if (needsParcels) {
		const source =
			sourceArg !== -1
				? process.argv[sourceArg + 1]
				: await ensureParcelDataset();
		shp = resolveShp(source);
		console.log(`parcel shapefile: ${shp}`);
	}

	fs.mkdirSync(OUT_DIR, { recursive: true });
	const boundsByRegion = {};

	for (const [region, regionAops] of byRegion) {
		const wineryAops = regionAops.filter((a) => a.kind === "winery");
		const cruAops = regionAops.filter(
			(a) => a.kind !== "winery" && COMMUNES_BY_AOP_ID[a.id],
		);
		const regionalAops = regionAops.filter((a) => a.kind === "regional");
		const detailAops = regionAops.filter(
			(a) =>
				a.kind !== "regional" &&
				a.kind !== "winery" &&
				!COMMUNES_BY_AOP_ID[a.id],
		);
		const features = [];

		if (detailAops.length > 0) {
			features.push(...(await buildDetailFeatures(shp, region, detailAops)));
		}
		if (cruAops.length > 0) {
			features.push(
				...(await buildCruFeatures(
					region,
					cruAops,
					communeFeatures,
					delegatedFeatures,
				)),
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
		if (wineryAops.length > 0) {
			features.push(...buildWineryFeatures(region, wineryAops));
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
				kind: meta.kind,
				// 塗り色のタグオーバーライド(特級)にレンダラが使う
				tags: meta.tags ?? [],
				rank: KIND_RANK[meta.kind],
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

/** 村名/畑: INAO区画データをAOC単位に結合・簡略化 */
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

/**
 * 村名AOC: COMMUNES_BY_AOP_ID のコミューン輪郭から境界を生成。
 * 村単位の精度が本質なので、regional 経路と違い欠落コードは即エラーにし、
 * gap-fill もしない。委任コミューン(旧村)を現行コミューンより優先して引く。
 */
async function buildCruFeatures(
	region,
	cruAops,
	communeFeatures,
	delegatedFeatures,
) {
	const inputFeatures = [];
	for (const aop of cruAops) {
		for (const code of COMMUNES_BY_AOP_ID[aop.id]) {
			const f = delegatedFeatures.get(code) ?? communeFeatures.get(code);
			if (!f) {
				throw new Error(
					`[${region}/cru] ${aop.id}: commune ${code} not found in contours`,
				);
			}
			inputFeatures.push({
				type: "Feature",
				properties: { id_app: aop.idApp, app: aop.name },
				geometry: f.geometry,
			});
		}
	}
	const tmpIn = path.join(CACHE_DIR, `${region}.cru.input.geojson`);
	const tmpOut = path.join(CACHE_DIR, `${region}.cru.geojson`);
	fs.writeFileSync(
		tmpIn,
		JSON.stringify({ type: "FeatureCollection", features: inputFeatures }),
	);
	await mapshaper.runCommands(
		[
			`-i ${tmpIn}`,
			`-split id_app`,
			`-dissolve2 target=* copy-fields=id_app,app`,
			`-merge-layers target=* force`,
			`-simplify interval=${DETAIL_SIMPLIFY_M} keep-shapes`,
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

/** シャトー(winery): 所在地座標から Point フィーチャを生成 */
function buildWineryFeatures(region, wineryAops) {
	return wineryAops.map((aop) => {
		const coords = WINERY_COORDS_BY_AOP_ID[aop.id];
		if (!coords) {
			throw new Error(`[${region}/winery] no coordinates for ${aop.id}`);
		}
		return {
			type: "Feature",
			properties: { id_app: aop.idApp, app: aop.name },
			geometry: { type: "Point", coordinates: coords },
		};
	});
}

async function loadCommuneContours(departments) {
	const map = new Map();
	for (const dept of departments) {
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

/**
 * 委任コミューン(commune déléguée/associée = 合併前の旧村)の輪郭。
 * 旧INSEEコードをキーにする。チェフリュー村は新旧同一コードのため
 * (例: Aÿ 51030 と現行 Aÿ-Champagne 51030)、現行コミューンとは別Mapで持つ。
 */
async function loadDelegatedCommuneContours(departments) {
	const map = new Map();
	for (const dept of departments) {
		const cached = path.join(CACHE_DIR, `communes-deleguees-${dept}.geojson`);
		if (!fs.existsSync(cached)) {
			console.log(`downloading delegated commune contours for dept ${dept}…`);
			const res = await fetch(
				`https://geo.api.gouv.fr/communes_associees_deleguees?codeDepartement=${dept}&format=geojson&geometry=contour`,
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
