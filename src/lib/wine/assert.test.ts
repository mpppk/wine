import { describe, expect, it } from "vitest";
import { BadRequestError } from "#/lib/errors";
import {
	assertKnownAop,
	assertKnownCountry,
	assertKnownRegion,
	assertKnownVariety,
	assertValidRefs,
	resolveAopIdOrThrow,
} from "./assert";

// #548: 静的マスタ参照の存在検証の共通関門。drunk-wine-service と
// reference-link-service が同じ関数を使うこと(SSOT化)をここで固定する。
describe("wine/assert", () => {
	it("既知のIDは通る", () => {
		expect(() => assertKnownAop("chablis")).not.toThrow();
		expect(() => assertKnownRegion("bourgogne")).not.toThrow();
		expect(() => assertKnownCountry("france")).not.toThrow();
		expect(() => assertKnownVariety("chardonnay")).not.toThrow();
		expect(() =>
			assertValidRefs({
				aopId: "chablis",
				regionId: "bourgogne",
				countryId: "france",
				grapeVarietyIds: ["chardonnay"],
			}),
		).not.toThrow();
	});

	it("未知のIDは BadRequest", () => {
		expect(() => assertKnownAop("no-such-aop")).toThrow(BadRequestError);
		expect(() => assertKnownRegion("no-such-region")).toThrow(BadRequestError);
		expect(() => assertKnownCountry("no-such-country")).toThrow(
			BadRequestError,
		);
		expect(() => assertKnownVariety("no-such-variety")).toThrow(
			BadRequestError,
		);
		expect(() => assertValidRefs({ aopId: "no-such-aop" })).toThrow(
			BadRequestError,
		);
		expect(() =>
			assertValidRefs({ grapeVarietyIds: ["chardonnay", "no-such-variety"] }),
		).toThrow(BadRequestError);
	});

	it("退役IDは後継として通る(#333)", () => {
		expect(() => assertKnownAop("chateau-la-gaffeliere")).not.toThrow();
		expect(resolveAopIdOrThrow("chateau-la-gaffeliere")).toBe(
			"saint-emilion-grand-cru",
		);
	});

	it("解決できないAOPは生値を返さず400にする(フォールバック廃止)", () => {
		expect(() => resolveAopIdOrThrow("no-such-aop")).toThrow(BadRequestError);
	});
});
