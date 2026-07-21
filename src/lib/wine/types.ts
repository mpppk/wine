// Domain types for the wine AOP study feature. Kept free of runtime imports so
// they can be shared by the data files, services, API routes, UI and MCP tools.

import type { AopTagId } from "./tags";

/**
 * これ以上の idApp は INAO の独立ポリゴンを持たない(地図に描かない)エントリ帯
 * (ブルゴーニュのクリマ・合成総称ノード)。ジオメトリ/重心の生成・整合チェックは
 * この値以上の idApp を対象外にする。scripts/*.mjs 側は同値のリテラルで判定する。
 */
export const POLYGONLESS_IDAPP_MIN = 930000;

/** ワインのタイプ(色) */
export type WineColor = "red" | "white" | "rose" | "sparkling" | "sweet-white";

/**
 * AOPエントリの区分(何を指す呼称か)。格付けではなく実体の種類を表す。
 * グラン・クリュ等の格付けは地域によって畑・村・ワイナリーのどれを指すかが
 * 変わるため、区分にせずタグ(tags.ts)で表現する。
 * winery はボルドーのシャトー等(メゾン/ドメーヌ含む)用。
 */
export type AopKind = "regional" | "village" | "vineyard" | "winery";

/**
 * 対応地域IDの単一の情報源(SSOT)。RegionId 型・入力検証の z.enum・
 * REGIONS の id 型・REGION_IDS はすべてこの配列から導出する。地域を追加する
 * 場合はここに1行足すだけでよく、型・検証・出題対象が自動で同期する。
 */
export const REGION_ID_LIST = [
	"bourgogne",
	"beaujolais",
	"champagne",
	"bordeaux",
	"piemonte",
	"toscana",
	"alsace",
	"loire",
	"rhone",
] as const;

export type RegionId = (typeof REGION_ID_LIST)[number];

export interface GrapeVariety {
	id: string;
	nameJa: string;
	/** 現地語表記(仏: "Pinot noir" / 伊: "Nebbiolo") */
	nameLocal: string;
	color: "red" | "white";
}

export interface AopGrape {
	varietyId: string;
	/** cahier des charges の主要品種(principaux)か補助品種(accessoires)か */
	role: "principal" | "accessory";
}

/**
 * AOPの主要な生産者。aops.json では名前だけの文字列としても書け、
 * 読み込み時にこの形へ正規化される(aop-schema.ts)。
 */
export interface AopProducer {
	/** 表示名 */
	name: string;
	/**
	 * ECサイト検索用のキーワード(カタカナ表記等)。省略時は
	 * affiliate.ts の共通辞書 → name の順でフォールバックする。
	 */
	searchKeyword?: string;
	/** 手動キュレーションの購入リンク。指定時は自動生成の検索リンクより優先 */
	links?: {
		rakuten?: string;
		amazon?: string;
	};
}

export interface Aop {
	/** URLセーフなスラッグ (例: "gevrey-chambertin") */
	id: string;
	/**
	 * GeoJSONフィーチャとの結合キー。フランス(INAO)は id_app の実値。
	 * 実体が無いものは合成IDを割り当てる:
	 *   - シャンパーニュの格付け村: 900001〜
	 *   - ボルドー: 地区/村AOC 910001〜、格付けシャトー 911001〜
	 *   - ピエモンテ(EU PDO由来): 920001〜 の連番。PDOid との対応は
	 *     scripts/build-italy-geodata.mjs の PIEMONTE_PDO 表が真実の源(追記のみ)。
	 *   - トスカーナ(EU PDO由来): 921001〜 の連番。PDOid との対応は
	 *     scripts/build-italy-geodata.mjs の TOSCANA_PDO 表が真実の源(追記のみ)。
	 *   - ロワール: 大半はINAOの id_app 実値を使うが、区画データに独立ポリゴンが
	 *     無く aire géographique から生成するAOC(カベルネ・ド・ソーミュール等)は
	 *     912001〜 の合成IDを割り当てる。
	 *   - ローヌ: 大半はINAOの id_app 実値を使うが、区画データに独立ポリゴンが無く
	 *     aire géographique から生成するAOC(コート・デュ・ローヌ・ヴィラージュ等)は
	 *     913001〜 の合成IDを割り当てる。
	 *   - ブルゴーニュのクリマ/合成総称ノード: 930001〜。INAOの独立ポリゴンを
	 *     持たない(地図に描かない)エントリ帯。ビルド/整合テストは idApp>=930000 を
	 *     ジオメトリ必須の対象から除外する(POLYGONLESS_IDAPP_MIN)。
	 */
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
	 * vineyard / winery のみ: この畑・シャトーが属する村名AOCのid。
	 * 複数村にまたがる畑(例: モンラシェ)は複数持ち、ツリー表示では各村の下に現れる。
	 * winery(ボルドーのシャトー)は所属する村名/地区AOCをちょうど1つ持つ。
	 */
	villageAopIds?: string[];
	/**
	 * vineyard のみ: この畑(クリマ)が内包される親の畑(総称AOC/合成総称ノード)のid。
	 * ちょうど1つ。個別クリマ(例: レ・クロ→chablis-grand-cru, フルショーム→
	 * chablis-premier-cru)がこれを持ち、ツリーでは親畑の下に入れ子表示される。
	 * parentAopId を持つ畑は villageAopIds を持たない(村は親から導出する)。
	 */
	parentAopId?: string;
	/**
	 * 法的に独立した原産地呼称(AOC/AOP・DOC/DOCG)か。省略時は isLegalAppellation()
	 * が kind 等から導出する。導出結果が実態と食い違うもの(合成総称ノード等)だけ
	 * 明示する。クリマである(kind:vineyard)ことと AOC であることは直交するため、
	 * バッジ表示は kind ではなくこの軸(isLegalAppellation)だけで駆動する。
	 */
	isAppellation?: boolean;
	/** 格付けタグ(特級/一級など)。省略時はタグなし。語彙は tags.ts が管理する */
	tags?: AopTagId[];
	colors: WineColor[];
	grapes: AopGrape[];
	/** 土壌の特徴(日本語) */
	soil: string;
	/**
	 * 主要な生産者。winery(シャトー)では所有者/運営体を入れる
	 * (購入リンクはシャトー自体に張り、所有者名には張らない)。
	 */
	producers: AopProducer[];
	/** 学習者向け解説(日本語) */
	description: string;
}

export interface Subregion {
	id: string;
	nameJa: string;
}

export interface Region {
	id: RegionId;
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
	/**
	 * 地方・地区の輪郭GeoJSONのパス(同一オリジン)。build:boundaries が出力する。
	 * 地方外グレーアウト(inverse mask)と地区境界線の描画に使う
	 */
	boundariesPath?: string;
	/** 境界データの出典表記(地図のattributionコントロールに表示)。外部データ利用時に設定 */
	boundaryAttribution?: string;
	subregions: Subregion[];
	description: string;
}
