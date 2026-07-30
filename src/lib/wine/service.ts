import { RETIRED_AOP_IDS } from "./aop-id-registry";
import { AOPS } from "./aops-data";
import { getRegion, REGIONS } from "./regions";
import type { AopTagId } from "./tags";
import type { Aop, AopKind, Region } from "./types";
import { GRAPE_VARIETIES, getVariety } from "./varieties";

// AOPデータへの問い合わせ層。データは全て静的(ビルド時生成)なので同期関数。
// APIルート・サーバ関数・MCPツールの三者から共用する。

export interface RegionSummary extends Region {
	aopCount: number;
}

export function listRegions(): RegionSummary[] {
	return REGIONS.map((region) => ({
		...region,
		aopCount: AOPS.filter((a) => a.region === region.id).length,
	}));
}

export { GRAPE_VARIETIES, getRegion, getVariety };

export interface ListAopsOptions {
	regionId?: string;
	/** この品種の使用が許可されているAOPのみ返す */
	grapeVarietyId?: string;
	kind?: AopKind;
	/** いずれかのタグを持つAOPのみ返す(OR結合) */
	tags?: AopTagId[];
	subregionId?: string;
}

export function listAops(options: ListAopsOptions = {}): Aop[] {
	const { regionId, grapeVarietyId, kind, tags, subregionId } = options;
	return AOPS.filter((aop) => {
		if (regionId && aop.region !== regionId) return false;
		if (kind && aop.kind !== kind) return false;
		if (tags?.length && !aop.tags?.some((t) => tags.includes(t))) return false;
		if (subregionId && aop.subregionId !== subregionId) return false;
		if (grapeVarietyId && !aopAllowsGrape(aop, grapeVarietyId)) return false;
		return true;
	});
}

export function aopAllowsGrape(aop: Aop, grapeVarietyId: string): boolean {
	return aop.grapes.some((g) => g.varietyId === grapeVarietyId);
}

/**
 * AOP を引く。aops.json から取り除かれた ID は RETIRED_AOP_IDS を辿って後継 AOP へ解決する
 * ため、その ID で登録済みのD1行(FKなし参照)が表示・地図から落ちない(#333)。
 */
export function getAop(aopId: string): Aop | undefined {
	const direct = AOPS.find((a) => a.id === aopId);
	if (direct) return direct;
	// 退役IDなら後継を辿る。多段の改名に備えてループしつつ、循環では止める。
	const seen = new Set<string>([aopId]);
	let next = RETIRED_AOP_IDS[aopId] ?? undefined;
	while (next && !seen.has(next)) {
		const aop = AOPS.find((a) => a.id === next);
		if (aop) return aop;
		seen.add(next);
		next = RETIRED_AOP_IDS[next] ?? undefined;
	}
	return undefined;
}

/**
 * 保存済みの AOP ID を現行の ID へ正規化する。解決できなければ undefined
 * (= 台帳にも無い未知のID、または後継無しとして退役した ID)。
 */
export function resolveAopId(aopId: string): string | undefined {
	return getAop(aopId)?.id;
}

/**
 * この AOP へ解決される退役ID(旧スラッグ)の一覧。aop_id を完全一致で引くクエリが、
 * 改名前のIDで保存された既存行も拾えるようにするために使う(#333)。
 */
export function legacyAopIdsFor(aopId: string): string[] {
	return Object.keys(RETIRED_AOP_IDS).filter(
		(retired) => getAop(retired)?.id === aopId,
	);
}

export function getAopByIdApp(idApp: number): Aop | undefined {
	return AOPS.find((a) => a.idApp === idApp);
}
