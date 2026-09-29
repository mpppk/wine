import { BadRequestError } from "#/lib/errors";
import { getCountry } from "./countries";
import { getRegion } from "./regions";
import { getAop, resolveAopId } from "./service";
import { getVariety } from "./varieties";

// 静的マスタ参照(aopId / regionId / countryId / grapeVarietyIds)の存在検証の
// 共通関門(Issue #548)。D1側はFKの無い文字列参照なので、検証はアプリの責任。
// drunk-wine-service の provenanceInsertValues / provenanceUpdateValues と
// reference-link-service の assertKnownAop が別々に持っていた検証をここへ集約し、
// 書き込み経路(Web/MCP/AI一括)はすべてここを通す。経路ごとに条件を書き散らさない
// (#177 / #185 と同じ類型)。

export interface ProvenanceRefs {
	aopId?: string | null;
	regionId?: string | null;
	countryId?: string | null;
	grapeVarietyIds?: string[];
}

export function assertKnownAop(aopId: string): void {
	// getAop は退役IDも後継へ解決する(#333)ので、旧IDはここを通る
	if (!getAop(aopId)) {
		throw new BadRequestError(`Unknown AOP: ${aopId}`);
	}
}

export function assertKnownRegion(regionId: string): void {
	if (!getRegion(regionId)) {
		throw new BadRequestError(`Unknown region: ${regionId}`);
	}
}

export function assertKnownCountry(countryId: string): void {
	if (!getCountry(countryId)) {
		throw new BadRequestError(`Unknown country: ${countryId}`);
	}
}

export function assertKnownVariety(varietyId: string): void {
	if (!getVariety(varietyId)) {
		throw new BadRequestError(`Unknown grape variety: ${varietyId}`);
	}
}

/** 4種の静的マスタ参照をまとめて検証する。null/undefined/空配列は対象外。 */
export function assertValidRefs(input: ProvenanceRefs): void {
	if (input.aopId) assertKnownAop(input.aopId);
	if (input.regionId) assertKnownRegion(input.regionId);
	if (input.countryId) assertKnownCountry(input.countryId);
	for (const id of input.grapeVarietyIds ?? []) {
		assertKnownVariety(id);
	}
}

/**
 * 保存用のAOP ID正規化。退役IDは現行IDへ解決し(#333)、解決できなければ
 * BadRequestErrorにする。`resolveAopId(x) ?? x`(解決失敗時の生値フォールバック)は
 * 不正なIDほど素通しさせるため廃止した(#548)。
 */
export function resolveAopIdOrThrow(aopId: string): string {
	const resolved = resolveAopId(aopId);
	if (!resolved) {
		throw new BadRequestError(`Unknown AOP: ${aopId}`);
	}
	return resolved;
}
