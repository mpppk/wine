import { AOPS } from "./aops-data";
import { getRegion, REGIONS } from "./regions";
import type { Aop, Classification, Region } from "./types";
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
	classification?: Classification;
	subregionId?: string;
}

export function listAops(options: ListAopsOptions = {}): Aop[] {
	const { regionId, grapeVarietyId, classification, subregionId } = options;
	return AOPS.filter((aop) => {
		if (regionId && aop.region !== regionId) return false;
		if (classification && aop.classification !== classification) return false;
		if (subregionId && aop.subregionId !== subregionId) return false;
		if (grapeVarietyId && !aopAllowsGrape(aop, grapeVarietyId)) return false;
		return true;
	});
}

export function aopAllowsGrape(aop: Aop, grapeVarietyId: string): boolean {
	return aop.grapes.some((g) => g.varietyId === grapeVarietyId);
}

export function getAop(aopId: string): Aop | undefined {
	return AOPS.find((a) => a.id === aopId);
}

export function getAopByIdApp(idApp: number): Aop | undefined {
	return AOPS.find((a) => a.idApp === idApp);
}
