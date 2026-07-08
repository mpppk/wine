#!/usr/bin/env node
// ピエモンテ(イタリア)のDOP境界GeoJSON(public/data/aop/piemonte.geojson)を生成する。
//
//   bun run build:geodata:italy                       # figshareからDL(キャッシュあり)
//   bun run build:geodata:italy -- --source /path/to/EU_PDO.gpkg   # ローカルのgpkgを使う
//
// データソース:
//  EU Wine PDO 境界データセット(コミューン単位のポリゴン)
//    Candiago, S. et al. "A geospatial inventory of regulatory information for wine
//    protected designations of origin in Europe." Sci Data 9, 394 (2022).
//    figshare: doi:10.6084/m9.figshare.19312094 (EU_PDO.gpkg, ライセンス CC0)
//
//  イタリアにはフランスINAOのような公式の区画GISが存在しないため、上記の学術
//  データセット(各PDOをeAmbrosia登録のコムーネ一覧から集約した境界)を用いる。
//  したがって粒度はコミューン単位で、フランスの村名/畑AOC(区画単位)より粗い。
//
// 仕組み(フランス版 build-aop-geodata.mjs との違い):
//  - gpkg は 1行 = 1 PDO の MultiPolygon。dissolve/split は不要(そのまま使う)。
//  - 座標系は EPSG:3035(ETRS89-LAEA)。mapshaper で wgs84 へ再投影する。
//  - 公式 id_app が無いため idApp は 910001〜 の連番(PIEMONTE_PDO 表)。PDOid との
//    対応もこの表が真実の源。aops.json の idApp と一致しなければ即エラーにする。
//  - 同一区分(kind)内で包含関係(例: Nizza ⊂ Barbera d'Asti)があるため、出力の
//    フィーチャ順は「rank昇順 → 面積降順」にする。同rankでは面積の小さいものを
//    後ろ(=最前面に描画)にして、hover/クリックが小さいDOP側に解決されるようにする。

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import mapshaper from "mapshaper";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".cache", "italy-geodata");
const OUT_DIR = path.join(ROOT, "public", "data", "aop");
const OUT_PATH = path.join(OUT_DIR, "piemonte.geojson");

// figshare "Wine PDO map" の EU_PDO.gpkg(約44MB)。生成物はコミットするので
// CIや利用者が毎回DLする必要はない(生成し直すときだけ取得)。
const GPKG_URL = "https://ndownloader.figshare.com/files/35955185";

// aops.json の aopId → eAmbrosia PDOid。追記のみ(既存行のidAppは変えない)。
// idApp は aops.json 側と突合するためここでは持たず、aops.json を真実の源とする。
const PIEMONTE_PDO = {
	barolo: "PDO-IT-A1389",
	barbaresco: "PDO-IT-A1399",
	dogliani: "PDO-IT-A1330",
	"dolcetto-di-diano-d-alba": "PDO-IT-A1324",
	"alta-langa": "PDO-IT-A1252",
	roero: "PDO-IT-A1261",
	"terre-alfieri": "PDO-IT-A1241",
	asti: "PDO-IT-A1396",
	"barbera-d-asti": "PDO-IT-A1398",
	nizza: "PDO-IT-01896",
	"barbera-del-monferrato-superiore": "PDO-IT-A1397",
	"ruche-di-castagnole-monferrato": "PDO-IT-A1258",
	"brachetto-d-acqui": "PDO-IT-A1382",
	"dolcetto-di-ovada-superiore": "PDO-IT-A1319",
	gavi: "PDO-IT-A1310",
	gattinara: "PDO-IT-A1311",
	ghemme: "PDO-IT-A1263",
	"erbaluce-di-caluso": "PDO-IT-A1315",
	piemonte: "PDO-IT-A1224",
	langhe: "PDO-IT-A1189",
	monferrato: "PDO-IT-A1210",
	"coste-della-sesia": "PDO-IT-A1138",
	"colli-tortonesi": "PDO-IT-A1097",
	"barbera-d-alba": "PDO-IT-A1068",
	"dolcetto-d-alba": "PDO-IT-A1142",
	"nebbiolo-d-alba": "PDO-IT-A1213",
	"verduno-pelaverga": "PDO-IT-A1244",
	bramaterra: "PDO-IT-A1075",
	lessona: "PDO-IT-A1191",
	// 注: Canelli(2023年DOCG独立)は2021年時点の本データセットに未収録のため
	// 今回は対象外。将来ISTATのコミューン境界等から別途生成する。
};

const KIND_RANK = { regional: 0, village: 1, vineyard: 2, winery: 3 };
const SIMPLIFY_M = 50; // コミューン単位なので粗めでよい
// ピエモンテ州を囲むbbox(WGS84, xmin,ymin,xmax,ymax)。データセットは各PDOを
// コミューン「名」から集約しているため、同名の他州コミューンを取り違えた飛び地が
// 一部の広域DOP(Barbera d'Asti/Monferrato等)に混入している(例: ヴェローナ付近
// 11°E)。州の実際の東端は約9.2°Eなので、このbboxでクリップして除去する。
const PIEMONTE_CLIP_BBOX = "6.4,43.9,9.5,46.7";

async function main() {
	const sourceArg = process.argv.indexOf("--source");
	const gpkgPath =
		sourceArg !== -1 ? process.argv[sourceArg + 1] : await ensureGpkg();
	console.log(`gpkg: ${gpkgPath}`);

	const aops = JSON.parse(
		fs.readFileSync(path.join(ROOT, "src/lib/wine/aops.json"), "utf8"),
	).filter((a) => a.region === "piemonte");

	// aops.json と PIEMONTE_PDO の集合が完全一致することを保証する
	const aopIds = new Set(aops.map((a) => a.id));
	const mapIds = new Set(Object.keys(PIEMONTE_PDO));
	for (const id of aopIds)
		if (!mapIds.has(id)) throw new Error(`PIEMONTE_PDO に ${id} が無い`);
	for (const id of mapIds)
		if (!aopIds.has(id))
			throw new Error(`aops.json に piemonte/${id} が無い(PDO表に余分)`);

	// gpkg から対象PDOのジオメトリを取り出し、EPSG:3035のGeoJSONを組む
	const db = new DatabaseSync(gpkgPath, { readOnly: true });
	const stmt = db.prepare("SELECT Shape FROM EU_PDO WHERE PDOid = ?");
	const inputFeatures = [];
	for (const aop of aops) {
		const pdoId = PIEMONTE_PDO[aop.id];
		const row = stmt.get(pdoId);
		if (!row || !row.Shape)
			throw new Error(`gpkg に ${pdoId}(${aop.id}) のジオメトリが無い`);
		const geom = parseWkb(gpkgToWkb(Buffer.from(row.Shape)));
		inputFeatures.push({
			type: "Feature",
			properties: { id_app: aop.idApp },
			geometry: geom,
		});
	}
	db.close();

	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const tmpIn = path.join(CACHE_DIR, "piemonte.input.geojson");
	const tmpOut = path.join(CACHE_DIR, "piemonte.simplified.geojson");
	fs.writeFileSync(
		tmpIn,
		JSON.stringify({ type: "FeatureCollection", features: inputFeatures }),
	);
	// 3035の平面で簡略化してから wgs84 へ再投影(中間GeoJSONにCRS情報が無いため
	// from=EPSG:3035 を明示)
	await mapshaper.runCommands(
		[
			`-i ${tmpIn}`,
			`-simplify interval=${SIMPLIFY_M} keep-shapes`,
			`-proj wgs84 from=EPSG:3035`,
			// 名称照合エラー由来の他州飛び地を州bboxで除去(上記コメント参照)
			`-clip bbox=${PIEMONTE_CLIP_BBOX}`,
			`-o ${tmpOut} format=geojson precision=0.00001 force`,
		].join(" "),
	);
	const simplified = JSON.parse(fs.readFileSync(tmpOut, "utf8"));

	// メタデータを結合してプロパティ契約に整える
	const metaByIdApp = new Map(aops.map((a) => [a.idApp, a]));
	for (const f of simplified.features) {
		if (!f.geometry)
			throw new Error(`null geometry: id_app=${f.properties.id_app}`);
		const meta = metaByIdApp.get(f.properties.id_app);
		if (!meta)
			throw new Error(`no metadata for id_app=${f.properties.id_app}`);
		f.properties = {
			idApp: meta.idApp,
			aopId: meta.id,
			name: meta.shortName,
			nameJa: meta.nameJa,
			kind: meta.kind,
			tags: meta.tags ?? [],
			rank: KIND_RANK[meta.kind],
			_area: polygonArea(f.geometry), // ソート用(出力前に消す)
		};
	}
	const found = new Set(simplified.features.map((f) => f.properties.idApp));
	const absent = aops.filter((a) => !found.has(a.idApp));
	if (absent.length)
		throw new Error(`missing geometry: ${absent.map((a) => a.id).join(", ")}`);

	// rank昇順 → 同rankは面積降順(小さいDOPを後ろ=最前面に)
	simplified.features.sort(
		(a, b) =>
			a.properties.rank - b.properties.rank ||
			b.properties._area - a.properties._area,
	);
	for (const f of simplified.features) f.properties._area = undefined;

	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(OUT_PATH, JSON.stringify(simplified));
	const mb = (fs.statSync(OUT_PATH).size / 1e6).toFixed(2);
	console.log(
		`wrote ${path.relative(ROOT, OUT_PATH)} (${simplified.features.length} features, ${mb}MB)`,
	);
	const b = computeBounds(simplified);
	console.log("\nbounds (src/lib/wine/regions.ts の piemonte.bounds に反映):");
	console.log(`  [${b.map((v) => v.toFixed(5)).join(", ")}]`);
}

/** figshare から EU_PDO.gpkg を取得(キャッシュ) */
async function ensureGpkg() {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const dest = path.join(CACHE_DIR, "EU_PDO.gpkg");
	if (!fs.existsSync(dest)) {
		console.log(`downloading ${GPKG_URL} (約44MB)…`);
		const res = await fetch(GPKG_URL);
		if (!res.ok) throw new Error(`download failed: ${res.status}`);
		fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
	}
	return dest;
}

// --- GeoPackage geometry BLOB → WKB(GPヘッダを剥がす) ---
function gpkgToWkb(buf) {
	if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error("not a GPKG geom blob");
	const flags = buf[3];
	const envelopeCode = (flags >> 1) & 0x07; // 0=none,1=xy,2=xyz,3=xym,4=xyzm
	const envBytes = [0, 32, 48, 48, 64][envelopeCode];
	return buf.subarray(8 + envBytes); // 2 magic +1 ver +1 flags +4 srs_id + envelope
}

// --- 最小WKBパーサ((Multi)Polygonのみ。他型は即エラー) ---
function parseWkb(buf) {
	let o = 0;
	const u32 = (le) => {
		const v = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
		o += 4;
		return v;
	};
	const ring = (le) => {
		const n = u32(le);
		const coords = new Array(n);
		for (let i = 0; i < n; i++) {
			const x = le ? buf.readDoubleLE(o) : buf.readDoubleBE(o);
			const y = le ? buf.readDoubleLE(o + 8) : buf.readDoubleBE(o + 8);
			o += 16;
			coords[i] = [x, y];
		}
		return coords;
	};
	const polygon = (le) => {
		const n = u32(le);
		const rings = new Array(n);
		for (let i = 0; i < n; i++) rings[i] = ring(le);
		return rings;
	};
	const geom = () => {
		const le = buf[o++] === 1;
		const type = u32(le) & 0xff;
		if (type === 3) return { type: "Polygon", coordinates: polygon(le) };
		if (type === 6) {
			const n = u32(le);
			const polys = new Array(n);
			for (let i = 0; i < n; i++) {
				const le2 = buf[o++] === 1;
				const t2 = u32(le2) & 0xff;
				if (t2 !== 3) throw new Error(`multipolygon child not polygon: ${t2}`);
				polys[i] = polygon(le2);
			}
			return { type: "MultiPolygon", coordinates: polys };
		}
		throw new Error(`unsupported WKB type ${type}`);
	};
	return geom();
}

/** 外周リングのシューレース面積の総和(ソート用の相対値。単位は不問) */
function polygonArea(geometry) {
	const rings =
		geometry.type === "MultiPolygon"
			? geometry.coordinates.map((p) => p[0])
			: [geometry.coordinates[0]];
	let area = 0;
	for (const ring of rings) {
		let a = 0;
		for (let i = 0, n = ring.length; i < n; i++) {
			const [x1, y1] = ring[i];
			const [x2, y2] = ring[(i + 1) % n];
			a += x1 * y2 - x2 * y1;
		}
		area += Math.abs(a) / 2;
	}
	return area;
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
