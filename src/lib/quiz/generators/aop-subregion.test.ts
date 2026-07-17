import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { getRegion, REGION_IDS } from "#/lib/wine/regions";
import { parseKey } from "../keys";
import { mulberry32 } from "../rng";
import {
	enumerateAopSubregionKeys,
	materializeAopSubregionQuestion,
} from "./aop-subregion";

const byId = new Map(AOPS.map((a) => [a.id, a]));

describe("所属地区クイズ", () => {
	it("全キーの全数スイープ: 4択・重複なし・正解が対象AOPの所属地区と一致", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateAopSubregionKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "aop-subregion") throw new Error(key);
				const q = materializeAopSubregionQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				const aop = byId.get(q.subjectAopId);
				// 正解の選択肢IDは対象AOPの subregionId
				expect(q.correctOptionId).toBe(aop?.subregionId);
				// 選択肢はすべて当該地域の subregion
				const subregionIds = new Set(
					getRegion(regionId)?.subregions.map((s) => s.id),
				);
				for (const option of q.options) {
					expect(subregionIds.has(option.id), `${key} ${option.id}`).toBe(true);
				}
			}
		}
	});

	it("地区が4つ未満の地域(アルザス/ボジョレー)は0問、複数地区の地域は出題される", () => {
		// アルザス(バ・ラン/オー・ランの2地区)・ボジョレー(1地区)は4択にできず0問
		expect(enumerateAopSubregionKeys("alsace")).toHaveLength(0);
		expect(enumerateAopSubregionKeys("beaujolais")).toHaveLength(0);
		// ブルゴーニュは実在地区が4つ以上あるので出題される
		expect(enumerateAopSubregionKeys("bourgogne").length).toBeGreaterThan(0);
	});

	it("広域AOC(regional)は主題にならない", () => {
		const regionalIds = new Set(
			AOPS.filter((a) => a.kind === "regional").map((a) => a.id),
		);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateAopSubregionKeys(regionId)) {
				const aopId = key.split(":")[1] ?? "";
				expect(regionalIds.has(aopId), key).toBe(false);
			}
		}
	});

	it("存在しないAOPは null", () => {
		expect(
			materializeAopSubregionQuestion(
				{ quizType: "aop-subregion", aopId: "no-such-aop" },
				mulberry32(1),
			),
		).toBeNull();
	});
});
