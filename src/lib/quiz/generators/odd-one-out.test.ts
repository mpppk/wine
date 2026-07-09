import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { aopAllowsGrape } from "#/lib/wine/service";
import type { Aop, WineColor } from "#/lib/wine/types";
import { type OddOneOutAxis, parseKey } from "../keys";
import { mulberry32 } from "../rng";
import {
	enumerateOddOneOutKeys,
	materializeOddOneOutQuestion,
} from "./odd-one-out";

const byId = new Map(AOPS.map((a) => [a.id, a]));

/** 軸ごとの「性質を持つか」述語(テスト側で独立に定義して実装と突き合わせる) */
function hasProperty(
	aop: Aop,
	axis: OddOneOutAxis,
	axisValue: string,
): boolean {
	switch (axis) {
		case "color":
			return aop.colors.includes(axisValue as WineColor);
		case "grape":
			return aopAllowsGrape(aop, axisValue);
		case "subregion":
			return aop.subregionId === axisValue;
		case "tag":
			return aop.tags?.includes(axisValue as "grand-cru") ?? false;
	}
}

describe("仲間外れクイズ", () => {
	it("全キーの全数スイープ: 正解だけが性質を欠き、他3つは持つ", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateOddOneOutKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "odd-one-out") throw new Error(key);
				const q = materializeOddOneOutQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				for (const option of q.options) {
					const aop = byId.get(option.id);
					expect(aop, `${key} option ${option.id}`).toBeDefined();
					if (!aop) continue;
					expect(
						hasProperty(aop, parsed.axis, parsed.axisValue),
						`${key} option ${option.id}`,
					).toBe(option.id !== q.correctOptionId);
				}
			}
		}
	});

	it("subregion軸の選択肢に広域(regional)AOCが出ない", () => {
		const rng = mulberry32(1);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateOddOneOutKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "odd-one-out" || parsed.axis !== "subregion")
					continue;
				const q = materializeOddOneOutQuestion(parsed, rng);
				for (const option of q?.options ?? []) {
					const kind = byId.get(option.id)?.kind;
					expect(kind === "village" || kind === "vineyard", key).toBe(true);
				}
			}
		}
	});

	it("premier-cru軸の正解は grand-cru も持たない村名AOC", () => {
		for (const regionId of REGION_IDS) {
			for (const key of enumerateOddOneOutKeys(regionId)) {
				const parsed = parseKey(key);
				if (
					parsed?.quizType !== "odd-one-out" ||
					parsed.axis !== "tag" ||
					parsed.axisValue !== "premier-cru"
				)
					continue;
				const answer = byId.get(parsed.aopId);
				expect(answer?.kind, key).toBe("village");
				expect(answer?.tags?.includes("grand-cru") ?? false, key).toBe(false);
			}
		}
	});

	it("ボジョレーは仲間外れが0問(単一サブリージョン・全AOP同色同品種のため)", () => {
		expect(enumerateOddOneOutKeys("beaujolais")).toHaveLength(0);
	});

	it("ブルゴーニュ・シャンパーニュでは問題が生成される", () => {
		expect(enumerateOddOneOutKeys("bourgogne").length).toBeGreaterThan(0);
		expect(enumerateOddOneOutKeys("champagne").length).toBeGreaterThan(0);
	});
});
