import type { FeatureCollection, Geometry, Position } from "geojson";
import type {
	ExpressionSpecification,
	MapGeoJSONFeature,
	Map as MaplibreMap,
	Popup,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";
import {
	BASEMAP_STYLE_URL,
	KIND_COLORS,
	KIND_LABELS_JA,
	KIND_RANK,
	kindFillColorExpr,
	kindLineColorExpr,
	progressFillColorExpr,
	progressLineColorExpr,
	REGION_BOUNDARY_STYLE,
} from "#/lib/wine/map-style";
import { aopAllowsGrape } from "#/lib/wine/service";
import { type AopTagId, formatAopTagJa } from "#/lib/wine/tags";
import {
	getAppellationTermJa,
	getVineyardTermJa,
} from "#/lib/wine/terminology";
import type { Aop, AopKind, Region } from "#/lib/wine/types";

const SOURCE_ID = "aops";
const FILL_LAYER = "aop-fill";
const LINE_LAYER = "aop-line";
// シャトー(winery)はポリゴンでなく点なので専用の circle レイヤで描く
const WINERY_LAYER = "aop-winery";
// 地方・地区境界(<region>-boundaries.geojson)。AOPレイヤの下に地方外マスクと
// 境界線を敷き、選択AOPの属する地区の強調線だけAOPポリゴンの上に重ねる
const BOUNDARIES_SOURCE_ID = "region-boundaries";
const MASK_SOURCE_ID = "region-mask";
const MASK_LAYER = "region-mask-fill";
const REGION_OUTLINE_LAYER = "region-outline";
const SUBREGION_LINE_LAYER = "subregion-line";
const SUBREGION_ACTIVE_LAYER = "subregion-line-active";
// 地区強調線の初期filter用。どの subregionId にも一致しない番兵値
const NO_SUBREGION = "__none__";

export interface AopMapViewProps {
	region: Region;
	aops: Aop[];
	/** 選択中AOP(詳細パネル表示中)。選択時はハイライトしてズームする */
	selectedAopId?: string;
	/** ブドウ品種フィルタ。指定時、許可されていないAOPは灰色に沈む */
	grapeVarietyId?: string;
	/** 指定時、含まれないAOPは灰色に沈む(マイセラーの「飲んだAOP」表示用) */
	highlightAopIds?: ReadonlySet<string>;
	/**
	 * 非表示にするAOPのid集合(区分・格付けの絞り込み結果)。指定時はこれを唯一の
	 * 非表示判定に使う。未指定時は visibleKinds/visibleTags から判定する(旧経路)。
	 */
	hiddenAopIds?: ReadonlySet<string>;
	/** 表示する区分。含まれない区分のAOPは非表示(hiddenAopIds 未指定時のみ有効) */
	visibleKinds?: AopKind[];
	/** 表示するタグ。空なら絞り込まない(hiddenAopIds 未指定時のみ有効) */
	visibleTags?: AopTagId[];
	/** 色分けモード。"kind"=区分別(既定) / "progress"=クイズ学習済み率 */
	colorMode?: "kind" | "progress";
	/** progress モード時のAOP別学習済み率(idApp -> 0〜1)。未収載=データなし */
	progressByIdApp?: Map<number, number>;
	onSelectAop?: (aopId: string | undefined) => void;
	/**
	 * 選択エリアへズームする際、地図に重なるUI(モバイルの下部詳細パネル等)が覆う
	 * ピクセル量を返す getter。fitBounds 実行時に呼ばれ、基準 padding に加算される。
	 * これにより覆われていない描画領域を基準に選択エリアを中心へ寄せる。
	 */
	getFitInset?: () => {
		top?: number;
		bottom?: number;
		left?: number;
		right?: number;
	};
	className?: string;
}

// 色分けモードごとの fill-opacity 式。進捗モードは緑バケットを判別しやすいよう
// 基準の不透明度を上げる(hidden/dimmed/selected/hover の分岐は共通)。
function fillOpacityExpr(
	colorMode: "kind" | "progress",
): ExpressionSpecification {
	const isProgress = colorMode === "progress";
	return [
		"case",
		["boolean", ["feature-state", "hidden"], false],
		0,
		["boolean", ["feature-state", "dimmed"], false],
		0.06,
		["boolean", ["feature-state", "selected"], false],
		isProgress ? 0.85 : 0.62,
		["boolean", ["feature-state", "hover"], false],
		isProgress ? 0.82 : 0.55,
		isProgress ? 0.72 : 0.38,
	] as unknown as ExpressionSpecification;
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
		if (x === undefined || y === undefined) return undefined;
		return [x, y, x, y];
	}
	return undefined;
}

// 選択エリアへズームする際の fitBounds padding。基準値に、地図へ重なるUIが覆う
// inset(getFitInset)を足す。padding の合計がキャンバスを超えると fitBounds が破綻
// するため、各軸で最低限の可視幅を残すようクランプする。
const BASE_FIT_PADDING = 80;
function computeFitPadding(
	inset: { top?: number; bottom?: number; left?: number; right?: number },
	width: number,
	height: number,
): { top: number; bottom: number; left: number; right: number } {
	// 各軸で padding 合計がこの割合を超えないよう抑える(=常に一定の可視域を残す)
	const MAX_AXIS_RATIO = 0.85;
	const clampAxis = (a: number, b: number, size: number): [number, number] => {
		const limit = size * MAX_AXIS_RATIO;
		const total = a + b;
		if (total <= limit || total === 0) return [a, b];
		const scale = limit / total;
		return [a * scale, b * scale];
	};
	const [top, bottom] = clampAxis(
		BASE_FIT_PADDING + (inset.top ?? 0),
		BASE_FIT_PADDING + (inset.bottom ?? 0),
		height,
	);
	const [left, right] = clampAxis(
		BASE_FIT_PADDING + (inset.left ?? 0),
		BASE_FIT_PADDING + (inset.right ?? 0),
		width,
	);
	return { top, bottom, left, right };
}

// 地方外グレーアウト用の inverse mask。世界を覆う外周リングに、地方輪郭の
// 各外周リングを穴として開ける(地方の内側だけスクリムが掛からない)。
// boundaries データは build:boundaries が内側の穴(enclave)を落としている前提。
function buildInverseMask(geometry: Geometry): FeatureCollection {
	const holes: Position[][] =
		geometry.type === "Polygon"
			? geometry.coordinates.slice(0, 1)
			: geometry.type === "MultiPolygon"
				? geometry.coordinates.flatMap((poly) => (poly[0] ? [poly[0]] : []))
				: [];
	return {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: {},
				geometry: {
					type: "Polygon",
					coordinates: [
						[
							[-180, -85],
							[180, -85],
							[180, 85],
							[-180, 85],
							[-180, -85],
						],
						...holes,
					],
				},
			},
		],
	};
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
	highlightAopIds,
	hiddenAopIds,
	visibleKinds,
	visibleTags,
	colorMode = "kind",
	progressByIdApp,
	onSelectAop,
	getFitInset,
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
		aopsById: new Map<string, Aop>(),
		onSelectAop,
		getFitInset,
		applyFeatureStates: () => {},
		applySelection: () => {},
		applyColorMode: () => {},
		applyProgress: () => {},
	});

	const aopsByIdApp = useMemo(() => {
		const m = new Map<number, Aop>();
		for (const aop of aops) m.set(aop.idApp, aop);
		return m;
	}, [aops]);
	const aopsById = useMemo(() => {
		const m = new Map<string, Aop>();
		for (const aop of aops) m.set(aop.id, aop);
		return m;
	}, [aops]);
	stateRef.current.aopsByIdApp = aopsByIdApp;
	stateRef.current.aopsById = aopsById;
	stateRef.current.onSelectAop = onSelectAop;
	stateRef.current.getFitInset = getFitInset;

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
				const [res, boundariesRes] = await Promise.all([
					fetch(region.geojsonPath ?? ""),
					region.boundariesPath
						? fetch(region.boundariesPath).catch(() => undefined)
						: Promise.resolve(undefined),
				]);
				if (cancelled || !res.ok) return;
				const geojson = (await res.json()) as FeatureCollection;
				for (const f of geojson.features) {
					const idApp = Number(f.properties?.idApp);
					const b = computeBounds(f.geometry);
					if (idApp && b) boundsRef.current[idApp] = b;
				}
				// 境界データは任意。取得失敗時はマスク・境界線なしで描画を続行する
				let boundaries: FeatureCollection | undefined;
				if (boundariesRes?.ok) {
					boundaries = (await boundariesRes.json()) as FeatureCollection;
				} else if (region.boundariesPath) {
					console.warn(`boundaries fetch failed: ${region.boundariesPath}`);
				}
				if (cancelled) return;

				if (boundaries) {
					// 地方外マスクと地方輪郭・地区破線はAOPレイヤの下に敷く
					const regionFeature = boundaries.features.find(
						(f) => f.properties?.level === "region",
					);
					if (regionFeature) {
						map.addSource(MASK_SOURCE_ID, {
							type: "geojson",
							data: buildInverseMask(regionFeature.geometry),
						});
						map.addLayer({
							id: MASK_LAYER,
							type: "fill",
							source: MASK_SOURCE_ID,
							paint: {
								"fill-color": REGION_BOUNDARY_STYLE.maskColor,
								"fill-opacity": REGION_BOUNDARY_STYLE.maskOpacity,
							},
						});
					}
					map.addSource(BOUNDARIES_SOURCE_ID, {
						type: "geojson",
						data: boundaries,
						attribution: region.boundaryAttribution,
					});
					map.addLayer({
						id: REGION_OUTLINE_LAYER,
						type: "line",
						source: BOUNDARIES_SOURCE_ID,
						filter: ["==", ["get", "level"], "region"],
						paint: {
							"line-color": REGION_BOUNDARY_STYLE.regionLine,
							"line-width": [
								"interpolate",
								["linear"],
								["zoom"],
								6,
								1.5,
								12,
								2.5,
							],
							"line-opacity": 0.85,
						},
					});
					map.addLayer({
						id: SUBREGION_LINE_LAYER,
						type: "line",
						source: BOUNDARIES_SOURCE_ID,
						filter: ["==", ["get", "level"], "subregion"],
						paint: {
							"line-color": REGION_BOUNDARY_STYLE.subregionLine,
							"line-width": [
								"interpolate",
								["linear"],
								["zoom"],
								7,
								1,
								12,
								1.8,
							],
							"line-opacity": 0.5,
							"line-dasharray": REGION_BOUNDARY_STYLE.subregionDash,
						},
					});
				}

				map.addSource(SOURCE_ID, {
					type: "geojson",
					data: geojson,
					promoteId: "idApp",
					attribution: region.boundaryAttribution,
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
						// 初期は区分色。progress モードなら load 後の applyColorMode で差し替える
						"fill-color": kindFillColorExpr(),
						"fill-opacity": fillOpacityExpr("kind"),
					},
				});
				map.addLayer({
					id: LINE_LAYER,
					type: "line",
					source: SOURCE_ID,
					filter: ["!=", ["get", "kind"], "winery"],
					paint: {
						// 初期は区分色。progress モードは load 後の applyColorMode で差し替える
						"line-color": kindLineColorExpr(),
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
				// 選択AOPの属する地区の強調線。AOPポリゴンに埋もれないよう上に重ねる
				// (filter は applySelection が選択AOPの subregionId に差し替える)
				if (boundaries) {
					map.addLayer({
						id: SUBREGION_ACTIVE_LAYER,
						type: "line",
						source: BOUNDARIES_SOURCE_ID,
						filter: ["==", ["get", "subregionId"], NO_SUBREGION],
						paint: {
							"line-color": REGION_BOUNDARY_STYLE.subregionActiveLine,
							"line-width": [
								"interpolate",
								["linear"],
								["zoom"],
								7,
								1.8,
								12,
								3,
							],
							"line-opacity": 0.85,
						},
					});
				}
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
				// 初期状態(フィルタ・選択・色分けモード・進捗)を反映。ロード中に
				// propsが変わっていても最新の値が適用されるようrefに入った関数を呼ぶ。
				stateRef.current.applyProgress();
				stateRef.current.applyColorMode();
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
									aop.kind === "vineyard"
										? getVineyardTermJa(aop.region)
										: KIND_LABELS_JA[aop.kind],
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
			const hidden = hiddenAopIds
				? hiddenAopIds.has(aop.id)
				: (visibleKinds !== undefined && !visibleKinds.includes(aop.kind)) ||
					(tagFilter.length > 0 &&
						!aop.tags?.some((t) => tagFilter.includes(t)));
			const dimmed =
				!hidden &&
				((grapeVarietyId !== undefined &&
					!aopAllowsGrape(aop, grapeVarietyId)) ||
					(highlightAopIds !== undefined && !highlightAopIds.has(aop.id)));
			map.setFeatureState(
				{ source: SOURCE_ID, id: aop.idApp },
				{ hidden, dimmed },
			);
		}
	};

	const applySelection = () => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		let selected: Aop | undefined;
		for (const aop of stateRef.current.aopsByIdApp.values()) {
			const isSelected = aop.id === selectedAopId;
			if (isSelected) selected = aop;
			map.setFeatureState(
				{ source: SOURCE_ID, id: aop.idApp },
				{ selected: isSelected },
			);
		}
		// 選択AOPの属する地区の境界線を実線で強調する。`*-regional`(広域AOCの
		// 置き場)は地理的地区ではないので強調しない。境界データが無い場合や
		// 地区ポリゴンが無い地区(収録AOPが無い地区)は何も描かれない
		if (map.getLayer(SUBREGION_ACTIVE_LAYER)) {
			const subregionId =
				selected && !selected.subregionId.endsWith("-regional")
					? selected.subregionId
					: NO_SUBREGION;
			map.setFilter(SUBREGION_ACTIVE_LAYER, [
				"==",
				["get", "subregionId"],
				subregionId,
			]);
		}
		if (selected) {
			// 選択AOPに境界が無い場合(個別クリマ・合成総称ノードはポリゴンを持たない)、
			// 親畑→村 と祖先を辿り、境界を持つ最初の祖先の範囲にズームして位置の目安を示す。
			const byId = stateRef.current.aopsById;
			let cursor: Aop | undefined = selected;
			const seen = new Set<string>();
			let b: [number, number, number, number] | undefined;
			while (cursor && !seen.has(cursor.id)) {
				seen.add(cursor.id);
				b = boundsRef.current[cursor.idApp];
				if (b) break;
				const parentId: string | undefined =
					cursor.parentAopId ?? cursor.villageAopIds?.[0];
				cursor = parentId ? byId.get(parentId) : undefined;
			}
			if (b) {
				const canvas = map.getCanvas();
				const padding = computeFitPadding(
					stateRef.current.getFitInset?.() ?? {},
					canvas.clientWidth,
					canvas.clientHeight,
				);
				map.fitBounds(b, { padding, maxZoom: 13.5, duration: 600 });
			}
		}
	};

	// 色分けモードに応じて塗り色・枠色・不透明度の paint 式を差し替える。
	// progress モードは feature-state.progress を step で色に写す(applyProgress が値を反映)。
	const applyColorMode = () => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const isProgress = colorMode === "progress";
		map.setPaintProperty(
			FILL_LAYER,
			"fill-color",
			isProgress ? progressFillColorExpr() : kindFillColorExpr(),
		);
		map.setPaintProperty(
			FILL_LAYER,
			"fill-opacity",
			fillOpacityExpr(colorMode),
		);
		map.setPaintProperty(
			LINE_LAYER,
			"line-color",
			isProgress ? progressLineColorExpr() : kindLineColorExpr(),
		);
		// シャトー(winery)も点で進捗を表す
		map.setPaintProperty(
			WINERY_LAYER,
			"circle-color",
			isProgress ? progressFillColorExpr() : KIND_COLORS.winery.fill,
		);
	};

	// AOP別の学習済み率を feature-state.progress に反映(データなしはunsetのまま)
	const applyProgress = () => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		for (const aop of stateRef.current.aopsByIdApp.values()) {
			const rate = progressByIdApp?.get(aop.idApp);
			map.setFeatureState(
				{ source: SOURCE_ID, id: aop.idApp },
				{ progress: rate ?? null },
			);
		}
	};

	stateRef.current.applyFeatureStates = applyFeatureStates;
	stateRef.current.applySelection = applySelection;
	stateRef.current.applyColorMode = applyColorMode;
	stateRef.current.applyProgress = applyProgress;

	useEffect(applyFeatureStates, [
		grapeVarietyId,
		highlightAopIds,
		hiddenAopIds,
		visibleKinds,
		visibleTags,
	]);
	useEffect(applySelection, [selectedAopId]);
	useEffect(applyColorMode, [colorMode]);
	useEffect(applyProgress, [progressByIdApp]);

	return (
		<div
			ref={containerRef}
			className={className}
			role="application"
			aria-label={`${region.nameJa}の${getAppellationTermJa(region.id)}地図`}
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
