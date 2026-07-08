// Domain types for the wine AOP study feature. Kept free of runtime imports so
// they can be shared by the data files, services, API routes, UI and MCP tools.

/** ワインのタイプ(色) */
export type WineColor = "red" | "white" | "rose" | "sparkling";

/** AOCの格付け階層。premier cru は村名AOC内の区画呼称なので独立の階層にしない */
export type Classification = "regional" | "village" | "grand-cru";

export type RegionId = "bourgogne" | "beaujolais";

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
	classification: Classification;
	/**
	 * grand-cru のみ: この畑が属する村名AOCのid。
	 * 複数村にまたがる畑(例: モンラシェ)は複数持ち、ツリー表示では各村の下に現れる
	 */
	villageAopIds?: string[];
	/** このAOC内にプルミエ・クリュの区画が存在するか */
	premierCru: boolean;
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
