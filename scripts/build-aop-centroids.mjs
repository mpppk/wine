#!/usr/bin/env node
// public/data/aop/<region>.geojson から各AOPの面積加重セントロイドを計算し、
// src/lib/wine/aop-centroids.json ({ aopId: [lng, lat] }) を出力する。
//
//   bun run build:centroids
//
// 位置関係クイズ(「最も北にある村名AOPは？」)の南北・東西比較に使う代表点。
// コミット済みのGeoJSONだけを入力にするため、INAOデータの再取得は不要。
// build:geodata でGeoJSONを再生成したら本スクリプトも再実行すること。
//
// セントロイドはリングごとのシューレース公式(外環=正、穴=負)を全ポリゴンで
// 合算した面積加重平均。飛び地を持つAOPでも面積の大きい本体に引かれるため、
// 単純な頂点平均より代表点として安定する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEO_DIR = path.join(ROOT, "public", "data", "aop");
const OUT_PATH = path.join(ROOT, "src", "lib", "wine", "aop-centroids.json");

/** リング([[lng,lat],...])の符号付き面積と面積加重セントロイド項を返す */
function ringCentroid(ring) {
	let area2 = 0; // 符号付き面積の2倍
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		const [x0, y0] = ring[i];
		const [x1, y1] = ring[i + 1];
		const cross = x0 * y1 - x1 * y0;
		area2 += cross;
		cx += (x0 + x1) * cross;
		cy += (y0 + y1) * cross;
	}
	return { area2, cx, cy };
}

/** Polygon/MultiPolygon の面積加重セントロイド [lng, lat] */
function geometryCentroid(geometry) {
	const polygons =
		geometry.type === "Polygon"
			? [geometry.coordinates]
			: geometry.type === "MultiPolygon"
				? geometry.coordinates
				: null;
	if (!polygons) throw new Error(`unsupported geometry: ${geometry.type}`);

	// GeoJSONの巻き方向(外環=反時計回り、穴=時計回り)により、符号付き面積を
	// そのまま合算すれば外環が正・穴が負として効く
	let area2 = 0;
	let cx = 0;
	let cy = 0;
	for (const rings of polygons) {
		for (const ring of rings) {
			const r = ringCentroid(ring);
			area2 += r.area2;
			cx += r.cx;
			cy += r.cy;
		}
	}
	if (Math.abs(area2) < 1e-12) throw new Error("degenerate geometry");
	return [cx / (3 * area2), cy / (3 * area2)];
}

function main() {
	const aops = JSON.parse(
		fs.readFileSync(path.join(ROOT, "src/lib/wine/aops.json"), "utf8"),
	);
	const aopIds = new Set(aops.map((a) => a.id));

	const centroids = {};
	for (const file of fs.readdirSync(GEO_DIR).filter((f) => f.endsWith(".geojson"))) {
		const gj = JSON.parse(fs.readFileSync(path.join(GEO_DIR, file), "utf8"));
		for (const feature of gj.features) {
			const aopId = feature.properties.aopId;
			if (!aopIds.has(aopId)) {
				throw new Error(`[${file}] unknown aopId in GeoJSON: ${aopId}`);
			}
			const [lng, lat] = geometryCentroid(feature.geometry);
			centroids[aopId] = [
				Number(lng.toFixed(5)),
				Number(lat.toFixed(5)),
			];
		}
	}

	// aops.json 側の欠落チェック(GeoJSONに無いAOPがあれば即エラー)
	const missing = aops.filter((a) => !centroids[a.id]);
	if (missing.length) {
		throw new Error(
			`missing centroids for: ${missing.map((a) => a.id).join(", ")}`,
		);
	}

	const sorted = Object.fromEntries(
		Object.entries(centroids).sort(([a], [b]) => a.localeCompare(b)),
	);
	fs.writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, "\t")}\n`);
	console.log(
		`wrote ${path.relative(ROOT, OUT_PATH)} (${Object.keys(sorted).length} AOPs)`,
	);
}

main();
