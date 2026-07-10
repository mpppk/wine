#!/usr/bin/env bun
// 地方(region)・地区(subregion)の境界GeoJSON(public/data/aop/<region>-boundaries.geojson)を生成する。
//
//   bun run build:boundaries                       # 全地域
//   bun run build:boundaries -- --region bourgogne # 特定地域だけ再生成
//
// AopMapView が「地方外グレーアウト(inverse mask)+地方輪郭線+地区破線」の描画に使う。
// ソースはコミット済みの public/data/aop/<region>.geojson(生成には build:geodata が先)と
// src/lib/wine/aops.json(aopId → subregionId の結合)のみで、INAO生データの再取得は不要。
//
// 生成方法: AOPポリゴンの結合(winery の Point は除外)。AOP区画は飛び地だらけなので、
// モルフォロジカル・クロージング(EPSG:3035 に投影して +grow(m) バッファ → dissolve →
// −shrink(m) バッファ)で帯状に連結してから簡略化する。バッファは必ず平面座標系で行う
// (wgs84 のまま行うと距離がずれる)。
//
// 地区(subregion)の扱い:
//  - `*-regional`(bourgogne-regional 等の「広域AOC置き場」)は地理的地区ではないので出力しない
//  - 地理的地区が1つしかない地方(ボジョレー=地方全体)は地区フィーチャを出力しない
//  - アルザスの地区は県そのもの(バ・ラン=67 / オー・ラン=68)なので、AOPの結合ではなく
//    県輪郭(geo.api.gouv.fr のコミューン輪郭を dissolve)∩ 地方輪郭 で生成する
//  - メンバーAOPが少なく実態より狭い地区(シャンパーニュの cote-des-bar 等)は、
//    COMMUNES_BY_SUBREGION にINSEEコードを足すとコミューン輪郭を結合に加えられる
//
// 出力フィーチャの properties:
//   { level: "region",    regionId,    nameJa }  … 1地方につき1つ
//   { level: "subregion", subregionId, nameJa }  … 地理的地区ぶん
// 面は輪郭表示専用なので内側の穴(enclave)は落とす(inverse mask 生成側は外周リングのみ扱う)。
//
// node ではなく bun で実行する(サブリージョン名を src/lib/wine/regions.ts から直接 import
// するため。重複定義によるドリフトを避ける)。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mapshaper from "mapshaper";
import { REGIONS } from "../src/lib/wine/regions.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".cache", "region-boundaries");
const OUT_DIR = path.join(ROOT, "public", "data", "aop");

/**
 * クロージング距離(m)。grow で飛び地を連結し shrink で輪郭を戻す。
 * grow > shrink にすると連結が残りやすい(その分わずかに太る)。
 * デフォルトはコミューン輪郭ベースの(ほぼ連続した)グループ向け。
 */
const DEFAULT_CLOSING = { grow: 800, shrink: 800 };
/** 区画ベースで飛び地が激しいグループ(数百〜千パーツ)向けの強めのクロージング */
const PARCEL_CLOSING = { grow: 1500, shrink: 1200 };
/** 地方輪郭のクロージング上書き。alsace は区画ベース900パーツ超の帯なので強め。 */
const REGION_CLOSING_OVERRIDES = {
	alsace: { grow: 1500, shrink: 1400 },
};
/** 地区クロージングの上書き(ブルゴーニュの区画ベース地区) */
const SUBREGION_CLOSING_OVERRIDES = {
	"cote-de-nuits": PARCEL_CLOSING,
	"cote-de-beaune": PARCEL_CLOSING,
	"cote-chalonnaise": PARCEL_CLOSING,
	"chablis-grand-auxerrois": PARCEL_CLOSING,
};

/** 除去する飛び地の最小面積(m²)と簡略化の許容誤差(m) */
const MIN_ISLAND_M2 = 2e6;
const SIMPLIFY_M = 100;

/** 地区=県 として県輪郭から生成する特例(アルザス)。subregionId → 県コード */
const DEPARTMENT_SUBREGIONS = {
	alsace: { "bas-rhin": "67", "haut-rhin": "68" },
};

/**
 * メンバーAOPだけでは実態より狭い地区に、コミューン輪郭を結合へ追加するための
 * キュレーション表(subregionId → INSEEコード配列)。現状は未使用だが、
 * 例: シャンパーニュの cote-des-bar(データ上は Les Riceys 1村のみ)を
 * 広げたくなったらここに追記する。
 */
const COMMUNES_BY_SUBREGION = {};

async function main() {
	const regionArg = process.argv.indexOf("--region");
	const regionFilter = regionArg !== -1 ? process.argv[regionArg + 1] : undefined;

	const aops = JSON.parse(
		fs.readFileSync(path.join(ROOT, "src/lib/wine/aops.json"), "utf8"),
	);
	const subregionIdByAopId = new Map(aops.map((a) => [a.id, a.subregionId]));

	const regions = REGIONS.filter(
		(r) => r.enabled && (!regionFilter || r.id === regionFilter),
	);
	if (regionFilter && regions.length === 0) {
		throw new Error(`--region ${regionFilter}: unknown or disabled region`);
	}

	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.mkdirSync(OUT_DIR, { recursive: true });

	for (const region of regions) {
		const geojson = JSON.parse(
			fs.readFileSync(
				path.join(ROOT, "public", region.geojsonPath.replace(/^\//, "")),
				"utf8",
			),
		);
		// winery(Point)を除いた全ポリゴン。地方輪郭は「地図に描かれるどのAOPポリゴンも
		// グレーアウトの下に沈まない」を不変条件とするため全AOPの結合にする
		// (クレマン・ド・ブルゴーニュ等の南伸もそのまま含む)。
		const polygons = geojson.features.filter(
			(f) => f.geometry.type !== "Point",
		);

		const features = [];

		// --- 地方輪郭 ---
		const regionOutPath = await buildGroupOutline(
			`${region.id}.region`,
			polygons,
			REGION_CLOSING_OVERRIDES[region.id] ?? DEFAULT_CLOSING,
		);
		const regionGeometry = readSingleGeometry(regionOutPath);
		features.push({
			type: "Feature",
			properties: { level: "region", regionId: region.id, nameJa: region.nameJa },
			geometry: regionGeometry,
		});

		// --- 地区 ---
		const geographic = region.subregions.filter(
			(s) => !s.id.endsWith("-regional"),
		);
		if (region.id in DEPARTMENT_SUBREGIONS) {
			for (const sub of geographic) {
				const dept = DEPARTMENT_SUBREGIONS[region.id][sub.id];
				if (!dept) throw new Error(`[${region.id}] no department for ${sub.id}`);
				const geometry = await buildDepartmentSubregion(
					region.id,
					sub.id,
					dept,
					regionOutPath,
				);
				features.push(subregionFeature(sub, geometry));
			}
		} else if (geographic.length >= 2) {
			// 地理的地区が1つだけの地方(ボジョレー)は地区=地方全体なので出力しない
			const bySubregion = new Map();
			for (const f of polygons) {
				const subregionId = subregionIdByAopId.get(f.properties.aopId);
				if (!subregionId) {
					throw new Error(
						`[${region.id}] no subregionId for aopId=${f.properties.aopId}`,
					);
				}
				if (subregionId.endsWith("-regional")) continue;
				if (!bySubregion.has(subregionId)) bySubregion.set(subregionId, []);
				bySubregion.get(subregionId).push(f);
			}
			for (const sub of geographic) {
				const members = bySubregion.get(sub.id) ?? [];
				members.push(...(await loadCuratedCommunes(sub.id)));
				if (members.length === 0) {
					// メンバーAOPが全て winery 等でポリゴンが無い地区はスキップ
					// (例: シャンパーニュの cote-de-sezanne は収録AOPが無い)
					console.log(`[${region.id}] ${sub.id}: no polygons, skipped`);
					continue;
				}
				const outPath = await buildGroupOutline(
					`${region.id}.${sub.id}`,
					members,
					SUBREGION_CLOSING_OVERRIDES[sub.id] ?? DEFAULT_CLOSING,
				);
				features.push(subregionFeature(sub, readSingleGeometry(outPath)));
			}
		}

		const outPath = path.join(OUT_DIR, `${region.id}-boundaries.geojson`);
		fs.writeFileSync(
			outPath,
			JSON.stringify({ type: "FeatureCollection", features }),
		);
		const kb = Math.round(fs.statSync(outPath).size / 1024);
		console.log(
			`[${region.id}] wrote ${path.relative(ROOT, outPath)} (${features.length} features, ${kb}KB)`,
		);
	}
}

function subregionFeature(sub, geometry) {
	return {
		type: "Feature",
		properties: { level: "subregion", subregionId: sub.id, nameJa: sub.nameJa },
		geometry,
	};
}

/**
 * ポリゴン群を dissolve + クロージングで1つの輪郭に落とす。
 * 中間結果をShapefileに書かない(build-aop-geodata.mjs 冒頭の教訓)。
 */
async function buildGroupOutline(name, features, closing) {
	const inPath = path.join(CACHE_DIR, `${name}.input.geojson`);
	const outPath = path.join(CACHE_DIR, `${name}.outline.geojson`);
	fs.writeFileSync(
		inPath,
		JSON.stringify({
			type: "FeatureCollection",
			// properties は使わない(dissolve で1つに潰す)
			features: features.map((f) => ({
				type: "Feature",
				properties: {},
				geometry: f.geometry,
			})),
		}),
	);
	await mapshaper.runCommands(
		[
			`-i ${inPath}`,
			// gap-fill-area: AOP同士の隙間スリバーやコミューン合併の穴を埋める
			`-dissolve gap-fill-area=30km2`,
			`-proj EPSG:3035`,
			`-buffer ${closing.grow}`,
			`-dissolve`,
			`-buffer radius=-${closing.shrink}`,
			`-filter-islands min-area=${MIN_ISLAND_M2}`,
			`-simplify interval=${SIMPLIFY_M} keep-shapes`,
			`-proj wgs84`,
			`-o ${outPath} format=geojson precision=0.00001 force`,
		].join(" "),
	);
	return outPath;
}

/** アルザス特例: 県コミューン輪郭を dissolve し、地方輪郭でクリップして地区にする */
async function buildDepartmentSubregion(regionId, subregionId, dept, regionOutPath) {
	const communesPath = await ensureCommuneContours(dept);
	const deptPath = path.join(CACHE_DIR, `dept-${dept}.outline.geojson`);
	await mapshaper.runCommands(
		[
			`-i ${communesPath}`,
			`-dissolve gap-fill-area=30km2`,
			`-o ${deptPath} format=geojson force`,
		].join(" "),
	);
	const outPath = path.join(CACHE_DIR, `${regionId}.${subregionId}.outline.geojson`);
	await mapshaper.runCommands(
		[
			`-i ${regionOutPath}`,
			`-clip ${deptPath}`,
			`-filter-islands min-area=${MIN_ISLAND_M2}`,
			`-o ${outPath} format=geojson precision=0.00001 force`,
		].join(" "),
	);
	return readSingleGeometry(outPath);
}

/** COMMUNES_BY_SUBREGION のキュレーション分をコミューン輪郭フィーチャとして読み込む */
async function loadCuratedCommunes(subregionId) {
	const codes = COMMUNES_BY_SUBREGION[subregionId];
	if (!codes?.length) return [];
	const features = [];
	const byDept = Map.groupBy(codes, (c) => c.slice(0, 2));
	for (const [dept, deptCodes] of byDept) {
		const communesPath = await ensureCommuneContours(dept);
		const gj = JSON.parse(fs.readFileSync(communesPath, "utf8"));
		const byCode = new Map(gj.features.map((f) => [f.properties.code, f]));
		for (const code of deptCodes) {
			const f = byCode.get(code);
			if (!f) throw new Error(`${subregionId}: commune ${code} not found`);
			features.push(f);
		}
	}
	return features;
}

/** geo.api.gouv.fr のコミューン輪郭(build-aop-geodata.mjs と同じキャッシュ方式) */
async function ensureCommuneContours(dept) {
	const cached = path.join(CACHE_DIR, `communes-${dept}.geojson`);
	if (!fs.existsSync(cached)) {
		console.log(`downloading commune contours for dept ${dept}…`);
		const res = await fetch(
			`https://geo.api.gouv.fr/communes?codeDepartement=${dept}&format=geojson&geometry=contour`,
		);
		if (!res.ok) throw new Error(`geo.api.gouv.fr ${dept}: ${res.status}`);
		fs.writeFileSync(cached, await res.text());
	}
	return cached;
}

/**
 * mapshaper 出力から単一の (Multi)Polygon を取り出し、内側の穴を落とす。
 * (properties 無し入力の dissolve 結果は GeometryCollection になることがある)
 */
function readSingleGeometry(filePath) {
	const gj = JSON.parse(fs.readFileSync(filePath, "utf8"));
	let geometry;
	if (gj.type === "FeatureCollection") {
		if (gj.features.length !== 1) {
			throw new Error(`${filePath}: expected 1 feature, got ${gj.features.length}`);
		}
		geometry = gj.features[0].geometry;
	} else if (gj.type === "GeometryCollection") {
		if (gj.geometries.length !== 1) {
			throw new Error(
				`${filePath}: expected 1 geometry, got ${gj.geometries.length}`,
			);
		}
		geometry = gj.geometries[0];
	} else {
		geometry = gj;
	}
	if (geometry.type === "Polygon") {
		return { type: "Polygon", coordinates: [geometry.coordinates[0]] };
	}
	if (geometry.type === "MultiPolygon") {
		return {
			type: "MultiPolygon",
			coordinates: geometry.coordinates.map((poly) => [poly[0]]),
		};
	}
	throw new Error(`${filePath}: unexpected geometry type ${geometry.type}`);
}

await main();
