import { buildAopTree } from "./aop-tree";
import { countryForRegion, getCountry, WINE_COUNTRIES } from "./countries";
import { getAop, getRegion, listAops, listRegions } from "./service";
import { normalizeLabelText } from "./text-normalize";
import type { Aop, Region } from "./types";

// 産地(国・地域・AOP)の統合選択の純ロジック。マイセラーの産地ピッカー
// (ProvenancePicker)が使う「候補の列挙・横断検索・表示名の解決」を、DOM 非依存で
// 単体テストできる形に切り出す(drunk-wine-payload.ts と同じ方針)。
//
// 「産地」は粒度の異なる3種類(国 / 地域 / AOP)のいずれか1つ。保存の排他
// (最も細かい1つだけ)は drunk-wine-service が強制し、ここは選択肢の表現だけを扱う。

/** 産地の選択値。高々1つのキーだけが入る(DrunkWineFieldsValue の部分集合)。 */
export interface ProvenanceValue {
	aopId?: string;
	regionId?: string;
	countryId?: string;
}

type ProvenanceOptionKind = "country" | "region" | "aop";

/** ピッカーの候補1件。ドリルダウンの行と検索結果の行の両方がこの形。 */
export interface ProvenanceOption {
	kind: ProvenanceOptionKind;
	id: string;
	nameJa: string;
	/** 現地語表記(AOPは shortName)。補助表示・検索キーワードに使う */
	nameLocal: string;
	/** 自身を含まない上位階層の表示名(例: ["フランス", "ブルゴーニュ", "シャブリ"]) */
	breadcrumb: string[];
	/** 選択時にフォームへ入る値 */
	value: ProvenanceValue;
}

function countryOption(countryId: string): ProvenanceOption | undefined {
	const country = getCountry(countryId);
	if (!country) return undefined;
	return {
		kind: "country",
		id: country.id,
		nameJa: country.nameJa,
		nameLocal: country.nameLocal,
		breadcrumb: [],
		value: { countryId: country.id },
	};
}

function regionOption(region: Region): ProvenanceOption {
	const country = countryForRegion(region);
	return {
		kind: "region",
		id: region.id,
		nameJa: region.nameJa,
		nameLocal: region.nameLocal,
		breadcrumb: country ? [country.nameJa] : [],
		value: { regionId: region.id },
	};
}

/**
 * AOPのパンくず。[国, 地域] に、畑・シャトーなら所属村(複数村は「/」区切り)、
 * クリマなら親畑を足す。地区(subregion)は村と同時に出すと長くなるので入れない。
 */
function aopBreadcrumb(aop: Aop, region: Region): string[] {
	const country = countryForRegion(region);
	const crumbs = country ? [country.nameJa, region.nameJa] : [region.nameJa];
	const parent = aop.parentAopId ? getAop(aop.parentAopId) : undefined;
	if (parent) {
		crumbs.push(parent.nameJa);
	} else if (aop.villageAopIds?.length) {
		const villages = aop.villageAopIds
			.map((id) => getAop(id)?.nameJa)
			.filter((n): n is string => !!n);
		if (villages.length > 0) crumbs.push(villages.join(" / "));
	}
	return crumbs;
}

function aopOption(aop: Aop, region: Region): ProvenanceOption {
	return {
		kind: "aop",
		id: aop.id,
		nameJa: aop.nameJa,
		nameLocal: aop.shortName,
		breadcrumb: aopBreadcrumb(aop, region),
		value: { aopId: aop.id },
	};
}

/** enabled な地域を1つ以上持つ国(ドリルダウンの最上位)。 */
export function listCountryOptions(): ProvenanceOption[] {
	const enabledRegions = listRegions().filter((r) => r.enabled);
	return WINE_COUNTRIES.filter((c) =>
		enabledRegions.some((r) => countryForRegion(r)?.id === c.id),
	)
		.map((c) => countryOption(c.id))
		.filter((o): o is ProvenanceOption => !!o);
}

/** 指定した国の enabled な地域。 */
export function listRegionOptions(countryId: string): ProvenanceOption[] {
	return listRegions()
		.filter((r) => r.enabled && countryForRegion(r)?.id === countryId)
		.map(regionOption);
}

/**
 * 地区ドリルダウンの1行。ツリー上の深さ(村=0、畑/シャトー=1、クリマ=2)で
 * インデント表示する。
 */
export interface AopBrowseItem {
	option: ProvenanceOption;
	depth: 0 | 1 | 2;
}

/**
 * ある地区のAOPを、リスト表示と同じ階層順(aop-tree.ts)で列挙する。
 * 地方名AOC(広域)→ 村(村 > 畑 > クリマ、シャトー)→ 未割り当て、の順。
 */
export function listAopBrowseItems(
	regionId: string,
	subregionId: string,
): AopBrowseItem[] {
	const region = getRegion(regionId);
	if (!region) return [];
	const subregion = region.subregions.find((s) => s.id === subregionId);
	if (!subregion) return [];
	const sections = buildAopTree(listAops({ regionId }), [subregion]);
	const items: AopBrowseItem[] = [];
	const push = (aop: Aop, depth: 0 | 1 | 2) =>
		items.push({ option: aopOption(aop, region), depth });
	for (const section of sections) {
		for (const aop of section.regionalAops) push(aop, 0);
		for (const node of section.villages) {
			push(node.village, 0);
			for (const vNode of node.vineyards) {
				push(vNode.vineyard, 1);
				for (const climat of vNode.climats) push(climat, 2);
			}
			for (const winery of node.wineries) push(winery, 1);
		}
		for (const aop of section.unassignedVineyards) push(aop, 0);
		for (const aop of section.unassignedWineries) push(aop, 0);
	}
	return items;
}

/** 現在の選択値を候補表現へ解決する(未選択・未知IDは undefined)。 */
export function resolveProvenanceOption(
	value: ProvenanceValue,
): ProvenanceOption | undefined {
	if (value.aopId) {
		const aop = getAop(value.aopId);
		const region = aop ? getRegion(aop.region) : undefined;
		return aop && region ? aopOption(aop, region) : undefined;
	}
	if (value.regionId) {
		const region = getRegion(value.regionId);
		return region ? regionOption(region) : undefined;
	}
	if (value.countryId) return countryOption(value.countryId);
	return undefined;
}

/**
 * ピッカーのボタン・一覧での産地表示名。細かい順に AOP名 > 地域名 > 国名。
 * DrunkWineEntry(aopNameJa はサーバ導出、regionId / countryId は導出込み)を
 * そのまま渡せる形にする。
 */
export function provenanceNameJa(link: {
	aopId?: string | null;
	aopNameJa?: string | null;
	regionId?: string | null;
	countryId?: string | null;
}): string | undefined {
	if (link.aopId) {
		// 表示名はサーバ導出済みがあれば使い、無ければマスタから引く
		return link.aopNameJa ?? getAop(link.aopId)?.nameJa ?? undefined;
	}
	if (link.regionId) return getRegion(link.regionId)?.nameJa;
	if (link.countryId) return getCountry(link.countryId)?.nameJa;
	return undefined;
}

/** 検索結果の上限。全516件のAOP+地域+国を横断するため、表示は絞る。 */
export const PROVENANCE_SEARCH_LIMIT = 50;

interface SearchCandidate {
	option: ProvenanceOption;
	/** 正規化済みの検索対象キーワード */
	keywords: string[];
}

// 候補は静的マスタのみから決まるので、モジュール内で遅延構築してキャッシュする
// (正規化はコストがあるため、ダイアログ入力のたびに全516件×3キーワードを
// 正規化し直さない)。
let searchCandidatesCache: SearchCandidate[] | undefined;

function searchCandidates(): SearchCandidate[] {
	if (searchCandidatesCache) return searchCandidatesCache;
	const candidates: SearchCandidate[] = [];
	const add = (option: ProvenanceOption, labels: string[]) =>
		candidates.push({
			option,
			keywords: labels.map(normalizeLabelText).filter((k) => k.length > 0),
		});
	for (const option of listCountryOptions()) {
		add(option, [option.nameJa, option.nameLocal, option.id]);
	}
	const regions = listRegions().filter((r) => r.enabled);
	for (const region of regions) {
		add(regionOption(region), [region.nameJa, region.nameLocal, region.id]);
	}
	for (const region of regions) {
		for (const aop of listAops({ regionId: region.id })) {
			add(aopOption(aop, region), [
				aop.nameJa,
				aop.shortName,
				aop.name,
				aop.id,
			]);
		}
	}
	searchCandidatesCache = candidates;
	return candidates;
}

/**
 * 国・地域・AOPを横断するインクリメンタル検索。
 * 前方一致を部分一致より優先し、同順位はマスタの定義順(国 → 地域 → AOP)を保つ。
 */
export function searchProvenance(
	query: string,
	limit: number = PROVENANCE_SEARCH_LIMIT,
): ProvenanceOption[] {
	const normalized = normalizeLabelText(query);
	if (!normalized) return [];
	const prefix: ProvenanceOption[] = [];
	const partial: ProvenanceOption[] = [];
	for (const candidate of searchCandidates()) {
		if (candidate.keywords.some((k) => k.startsWith(normalized))) {
			prefix.push(candidate.option);
		} else if (candidate.keywords.some((k) => k.includes(normalized))) {
			partial.push(candidate.option);
		}
		if (prefix.length >= limit) break;
	}
	return [...prefix, ...partial].slice(0, limit);
}
