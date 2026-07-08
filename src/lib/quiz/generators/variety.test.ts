import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { aopAllowsGrape } from "#/lib/wine/service";
import { parseKey } from "../keys";
import { mulberry32 } from "../rng";
import { enumerateVarietyKeys, materializeVarietyQuestion } from "./variety";

const REGION_IDS = ["bourgogne", "beaujolais", "champagne"] as const;
const byId = new Map(AOPS.map((a) => [a.id, a]));

describe("品種フォーカスクイズ", () => {
	it("全キーの全数スイープ: 正解はprincipal・誤答は品種を全く含まない", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateVarietyKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "variety") throw new Error(key);
				const q = materializeVarietyQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				const correct = byId.get(q.correctOptionId);
				expect(
					correct?.grapes.some(
						(g) => g.varietyId === parsed.varietyId && g.role === "principal",
					),
					key,
				).toBe(true);
				for (const option of q.options) {
					if (option.id === q.correctOptionId) continue;
					const aop = byId.get(option.id);
					expect(aop, key).toBeDefined();
					if (!aop) continue;
					expect(
						aopAllowsGrape(aop, parsed.varietyId),
						`${key} ${option.id}`,
					).toBe(false);
				}
			}
		}
	});

	it("地域ごとの成立品種の分布回帰", () => {
		// ボジョレーは全AOPがガメイ等を許可するためディストラクタ不足で0問
		expect(enumerateVarietyKeys("beaujolais")).toHaveLength(0);
		// シャンパーニュで成立するのはムニエのみ(シャルドネ/ピノ・ノワールは全AOPが許可)
		const champagneVarieties = new Set(
			enumerateVarietyKeys("champagne").map((k) => k.split(":")[1]),
		);
		expect([...champagneVarieties]).toEqual(["meunier"]);
		// ブルゴーニュは多数の品種で成立する
		const bourgogneVarieties = new Set(
			enumerateVarietyKeys("bourgogne").map((k) => k.split(":")[1]),
		);
		expect(bourgogneVarieties.size).toBeGreaterThanOrEqual(5);
		expect(bourgogneVarieties.has("gamay")).toBe(true);
		expect(bourgogneVarieties.has("aligote")).toBe(true);
	});
});
