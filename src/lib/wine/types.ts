// Domain types for the wine AOP study feature. Kept free of runtime imports so
// they can be shared by the data files, services, API routes, UI and MCP tools.

import type { AopTagId } from "./tags";

/** ワインのタイプ(色) */
export type WineColor = "red" | "white" | "rose" | "sparkling";

/**
 * AOPエントリの区分(何を指す呼称か)。格付けではなく実体の種類を表す。
 * グラン・クリュ等の格付けは地域によって畑・村・ワイナリーのどれを指すかが
 * 変わるため、区分にせずタグ(tags.ts)で表現する。
 * winery はボルドーのシャトー等(メゾン/ドメーヌ含む)用。現状データは0件。
 */
export type AopKind = "regional" | "village" | "vineyard" | "winery";

export type RegionId = "bourgogne" | "beaujolais" | "champagne";

export interface GrapeVariety {
	id: string;
	nameJa: string;
	nameFr: string;
	color: "red" | "white";
}

export interface AopGrape {
	varietyId: string;
	/** cahier des charges の主要品種(principaux)か補助品種(accessoires)か */
	role: "principal" | "accessory";
}

export interface Aop {
	/** URLセーフなスラッグ (例: "gevrey-chambertin") */
	id: string;
	/** INAOデータセットの id_app。GeoJSONフィーチャとの結合キー */
	idApp: number;
	/** INAO表記の正式名称 */
	name: string;
	/** 表示用の短い名称 ("ou 〜" の別名を省いたもの) */
	shortName: string;
	nameJa: string;
	region: RegionId;
	subregionId: string;
	kind: AopKind;
	/**
	 * vineyard のみ: この畑が属する村名AOCのid。
	 * 複数村にまたがる畑(例: モンラシェ)は複数持ち、ツリー表示では各村の下に現れる
	 */
	villageAopIds?: string[];
	/** 格付けタグ(特級/一級など)。省略時はタグなし。語彙は tags.ts が管理する */
	tags?: AopTagId[];
	colors: WineColor[];
	grapes: AopGrape[];
	/** 土壌の特徴(日本語) */
	soil: string;
	/** 主要な生産者 */
	producers: string[];
	/** 学習者向け解説(日本語) */
	description: string;
}

export interface Subregion {
	id: string;
	nameJa: string;
}

export interface Region {
	id: string;
	nameJa: string;
	nameLocal: string;
	country: string;
	countryJa: string;
	/** 地図とデータが利用可能か。false は「準備中」として選択画面に表示する */
	enabled: boolean;
	/** [west, south, east, north] (WGS84)。build:geodata が出力した値 */
	bounds?: [number, number, number, number];
	/** AOP境界GeoJSONのパス(同一オリジン) */
	geojsonPath?: string;
	subregions: Subregion[];
	description: string;
}
