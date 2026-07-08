import type { FeatureCollection, Geometry } from "geojson";
import type { MapGeoJSONFeature, Map as MaplibreMap, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";
import {
	BASEMAP_STYLE_URL,
	GRAND_CRU_TAG_COLOR,
	KIND_COLORS,
	KIND_LABELS_JA,
	KIND_RANK,
} from "#/lib/wine/map-style";
import { aopAllowsGrape } from "#/lib/wine/service";
import { type AopTagId, formatAopTagJa } from "#/lib/wine/tags";
import type { Aop, AopKind, Region } from "#/lib/wine/types";

const SOURCE_ID = "aops";
const FILL_LAYER = "aop-fill";
const LINE_LAYER = "aop-line";
// シャトー(winery)はポリゴンでなく点なので専用の circle レイヤで描く
const WINERY_LAYER = "aop-winery";

export interface AopMapViewProps {
	region: Region;
	aops: Aop[];
	/** 選択中AOP(詳細パネル表示中)。選択時はハイライトしてズームする */
	selectedAopId?: string;
	/** ブドウ品種フィルタ。指定時、許可されていないAOPは灰色に沈む */
	grapeVarietyId?: string;
	/** 表示する区分。含まれない区分のAOPは非表示 */
	visibleKinds: AopKind[];
	/** 表示するタグ。空なら絞り込まない。指定時はいずれかのタグを持つAOPのみ表示 */
	visibleTags?: AopTagId[];
	onSelectAop?: (aopId: string | undefined) => void;
	className?: string;
}

interface FeatureBounds {
	[idApp: number]: [number, number, number, number];
}

// GeoJSONフィーチャの座標からbboxを計算(選択AOPへのズームに使う)
function computeBounds(
	geometry: Geometry,
): [number, number, number, number] | undefined {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	const visit = (coords: unknown): void => {
		if (!Array.isArray(coords) || coords.length === 0) return;
		if (typeof coords[0] === "number") {
			const x = coords[0] as number;
			const y = coords[1] as number;
			if (x < west) west = x;
			if (x > east) east = x;
			if (y < south) south = y;
			if (y > north) north = y;
			return;
		}
		for (const c of coords) visit(c);
	};
	if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
		visit(geometry.coordinates);
		return [west, south, east, north];
	}
	if (geometry.type === "Point") {
		const [x, y] = geometry.coordinates;
		return [x, y, x, y];
	}
	return undefined;
}

// hover/クリック位置のフィーチャから「最も区分ランクの高い(=最前面の)」ものを選ぶ。
// 同ランク(例: サンテミリオンとサンテミリオン・グラン・クリュの同形ポリゴン)は
// idApp昇順で決定的に選ぶ
function pickTopFeature(
	features: MapGeoJSONFeature[],
	aopsByIdApp: Map<number, Aop>,
): Aop | undefined {
	let best: Aop | undefined;
	for (const f of features) {
		const idApp = typeof f.id === "number" ? f.id : Number(f.id);
		const aop = aopsByIdApp.get(idApp);
		if (!aop) continue;
		if (!best) {
			best = aop;
			continue;
		}
		const d = KIND_RANK[aop.kind] - KIND_RANK[best.kind];
		if (d > 0 || (d === 0 && aop.idApp < best.idApp)) {
			best = aop;
		}
	}
	return best;
}

export function AopMapView({
	region,
	aops,
	selectedAopId,
	grapeVarietyId,
	visibleKinds,
	visibleTags,
	onSelectAop,
	className,
}: AopMapViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<MaplibreMap | null>(null);
	const popupRef = useRef<Popup | null>(null);
	const hoveredIdRef = useRef<number | undefined>(undefined);
	const boundsRef = useRef<FeatureBounds>({});
	const loadedRef = useRef(false);
	// イベントハンドラや地図ロード完了時に最新のprops/関数を参照するためのref
	const stateRef = useRef({
		aopsByIdApp: new Map<number, Aop>(),
		onSelectAop,
		applyFeatureStates: () => {},
		applySelection: () => {},
	});

	const aopsByIdApp = useMemo(() => {
		const m = new Map<number, Aop>();
		for (const aop of aops) m.set(aop.idApp, aop);
		return m;
	}, [aops]);
	stateRef.current.aopsByIdApp = aopsByIdApp;
	stateRef.current.onSelectAop = onSelectAop;

	// 初期化(1回のみ)。maplibre-glはSSR不可なのでeffect内で動的import。
	// 地図インスタンスは地域が変わったときだけ作り直す。
	// biome-ignore lint/correctness/useExhaustiveDependencies: region.id以外はref経由で最新値を参照する
	useEffect(() => {
		const container = containerRef.current;
		if (!container || mapRef.current) return;
		let cancelled = false;

		(async () => {
			const maplibregl = (await import("maplibre-gl")).default;
			if (cancelled || !containerRef.current) return;

			const map = new maplibregl.Map({
				container,
				style: BASEMAP_STYLE_URL,
				bounds: region.bounds,
				fitBoundsOptions: { padding: 24 },
				attributionControl: { compact: true },
			});
			mapRef.current = map;
			map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

			const popup = new maplibregl.Popup({
				closeButton: false,
				closeOnClick: false,
				maxWidth: "260px",
				className: "aop-popup",
			});
			popupRef.current = popup;

			map.on("load", async () => {
				if (cancelled) return;
				// bbox計算のためGeoJSONは自前でfetchしてdataで渡す(二重fetch回避)
				const res = await fetch(region.geojsonPath ?? "");
				if (cancelled || !res.ok) return;
				const geojson = (await res.json()) as FeatureCollection;
				for (const f of geojson.features) {
					const idApp = Number(f.properties?.idApp);
					const b = computeBounds(f.geometry);
					if (idApp && b) boundsRef.current[idApp] = b;
				}

				map.addSource(SOURCE_ID, {
					type: "geojson",
					data: geojson,
					promoteId: "idApp",
				});
				map.addLayer({
					id: FILL_LAYER,
					type: "fill",
					source: SOURCE_ID,
					// winery は点なので fill/line からは除外し、circle レイヤで描く
					filter: ["!=", ["get", "kind"], "winery"],
					layout: {
						"fill-sort-key": ["coalesce", ["get", "rank"], 1],
					},
					paint: {
						// 特級タグ持ちは区分に関わらず最濃色(シャンパーニュ特級村の見た目維持)
						"fill-color": [
							"case",
							[
								"in",
								"grand-cru",
								["coalesce", ["get", "tags"], ["literal", []]],
							],
							GRAND_CRU_TAG_COLOR.fill,
							[
								"match",
								["get", "kind"],
								"regional",
								KIND_COLORS.regional.fill,
								"village",
								KIND_COLORS.village.fill,
								"vineyard",
								KIND_COLORS.vineyard.fill,
								"winery",
								KIND_COLORS.winery.fill,
								KIND_COLORS.village.fill,
							],
						],
						"fill-opacity": [
							"case",
							["boolean", ["feature-state", "hidden"], false],
							0,
							["boolean", ["feature-state", "dimmed"], false],
							0.06,
							["boolean", ["feature-state", "selected"], false],
							0.62,
							["boolean", ["feature-state", "hover"], false],
							0.55,
							0.38,
						],
					},
				});
				map.addLayer({
					id: LINE_LAYER,
					type: "line",
					source: SOURCE_ID,
					filter: ["!=", ["get", "kind"], "winery"],
					paint: {
						"line-color": [
							"case",
							[
								"in",
								"grand-cru",
								["coalesce", ["get", "tags"], ["literal", []]],
							],
							GRAND_CRU_TAG_COLOR.line,
							[
								"match",
								["get", "kind"],
								"regional",
								KIND_COLORS.regional.line,
								"village",
								KIND_COLORS.village.line,
								"vineyard",
								KIND_COLORS.vineyard.line,
								"winery",
								KIND_COLORS.winery.line,
								KIND_COLORS.village.line,
							],
						],
						"line-width": [
							"case",
							["boolean", ["feature-state", "selected"], false],
							2.5,
							["boolean", ["feature-state", "hover"], false],
							1.8,
							0.8,
						],
						"line-opacity": [
							"case",
							["boolean", ["feature-state", "hidden"], false],
							0,
							["boolean", ["feature-state", "dimmed"], false],
							0.15,
							0.9,
						],
					},
				});
				// シャトー(winery): ポイントマーカー。ポリゴンの最前面に置く
				map.addLayer({
					id: WINERY_LAYER,
					type: "circle",
					source: SOURCE_ID,
					filter: ["==", ["get", "kind"], "winery"],
					paint: {
						"circle-color": KIND_COLORS.winery.fill,
						"circle-stroke-color": "#ffffff",
						"circle-radius": [
							"interpolate",
							["linear"],
							["zoom"],
							8,
							[
								"case",
								["boolean", ["feature-state", "selected"], false],
								6,
								3.5,
							],
							13,
							[
								"case",
								["boolean", ["feature-state", "selected"], false],
								11,
								7,
							],
						],
						"circle-stroke-width": [
							"case",
							["boolean", ["feature-state", "selected"], false],
							2.5,
							["boolean", ["feature-state", "hover"], false],
							2,
							1,
						],
						"circle-opacity": [
							"case",
							["boolean", ["feature-state", "hidden"], false],
							0,
							["boolean", ["feature-state", "dimmed"], false],
							0.15,
							0.92,
						],
						"circle-stroke-opacity": [
							"case",
							["boolean", ["feature-state", "hidden"], false],
							0,
							["boolean", ["feature-state", "dimmed"], false],
							0.2,
							1,
						],
					},
				});

				loadedRef.current = true;
				// 初期状態(フィルタ・選択)を反映。ロード中にpropsが変わっていても
				// 最新の値が適用されるようrefに入った関数を呼ぶ。
				stateRef.current.applyFeatureStates();
				stateRef.current.applySelection();
			});

			const clearHover = () => {
				if (hoveredIdRef.current !== undefined) {
					map.setFeatureState(
						{ source: SOURCE_ID, id: hoveredIdRef.current },
						{ hover: false },
					);
					hoveredIdRef.current = undefined;
				}
				popup.remove();
				map.getCanvas().style.cursor = "";
			};

			map.on("mousemove", (e) => {
				if (!loadedRef.current) return;
				const features = map
					.queryRenderedFeatures(e.point, {
						layers: [FILL_LAYER, WINERY_LAYER],
					})
					.filter((f) => {
						const st = map.getFeatureState({ source: SOURCE_ID, id: f.id });
						return !st.hidden && !st.dimmed;
					});
				const aop = pickTopFeature(features, stateRef.current.aopsByIdApp);
				if (!aop) {
					clearHover();
					return;
				}
				if (hoveredIdRef.current !== aop.idApp) {
					if (hoveredIdRef.current !== undefined) {
						map.setFeatureState(
							{ source: SOURCE_ID, id: hoveredIdRef.current },
							{ hover: false },
						);
					}
					hoveredIdRef.current = aop.idApp;
					map.setFeatureState(
						{ source: SOURCE_ID, id: aop.idApp },
						{ hover: true },
					);
				}
				map.getCanvas().style.cursor = "pointer";
				popup
					.setLngLat(e.lngLat)
					.setHTML(
						`<div class="aop-popup-body"><strong>${escapeHtml(aop.nameJa)}</strong>` +
							`<span>${escapeHtml(aop.shortName)}</span>` +
							`<em>${escapeHtml(
								[
									KIND_LABELS_JA[aop.kind],
									...(aop.tags ?? []).map((t) => formatAopTagJa(aop, t)),
								].join(" / "),
							)}</em></div>`,
					)
					.addTo(map);
			});
			map.on("mouseout", clearHover);

			map.on("click", (e) => {
				if (!loadedRef.current) return;
				const features = map
					.queryRenderedFeatures(e.point, {
						layers: [FILL_LAYER, WINERY_LAYER],
					})
					.filter((f) => {
						const st = map.getFeatureState({ source: SOURCE_ID, id: f.id });
						return !st.hidden && !st.dimmed;
					});
				const aop = pickTopFeature(features, stateRef.current.aopsByIdApp);
				stateRef.current.onSelectAop?.(aop?.id);
			});
		})();

		return () => {
			cancelled = true;
			loadedRef.current = false;
			popupRef.current?.remove();
			mapRef.current?.remove();
			mapRef.current = null;
		};
	}, [region.id]);

	// フィルタ(品種・区分・タグ)を feature-state に反映
	const applyFeatureStates = () => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const tagFilter = visibleTags ?? [];
		for (const aop of stateRef.current.aopsByIdApp.values()) {
			const hidden =
				!visibleKinds.includes(aop.kind) ||
				(tagFilter.length > 0 && !aop.tags?.some((t) => tagFilter.includes(t)));
			const dimmed =
				!hidden &&
				grapeVarietyId !== undefined &&
				!aopAllowsGrape(aop, grapeVarietyId);
			map.setFeatureState(
				{ source: SOURCE_ID, id: aop.idApp },
				{ hidden, dimmed },
			);
		}
	};

	const applySelection = () => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		for (const aop of stateRef.current.aopsByIdApp.values()) {
			map.setFeatureState(
				{ source: SOURCE_ID, id: aop.idApp },
				{ selected: aop.id === selectedAopId },
			);
		}
		if (selectedAopId) {
			let selected: Aop | undefined;
			for (const a of stateRef.current.aopsByIdApp.values()) {
				if (a.id === selectedAopId) {
					selected = a;
					break;
				}
			}
			const b = selected ? boundsRef.current[selected.idApp] : undefined;
			if (b) {
				map.fitBounds(b, { padding: 80, maxZoom: 13.5, duration: 600 });
			}
		}
	};

	stateRef.current.applyFeatureStates = applyFeatureStates;
	stateRef.current.applySelection = applySelection;

	useEffect(applyFeatureStates, [grapeVarietyId, visibleKinds, visibleTags]);
	useEffect(applySelection, [selectedAopId]);

	return (
		<div
			ref={containerRef}
			className={className}
			role="application"
			aria-label={`${region.nameJa}のAOP地図`}
		/>
	);
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
