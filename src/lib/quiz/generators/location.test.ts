import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { getCentroid } from "#/lib/wine/centroids";
import { REGION_IDS } from "#/lib/wine/regions";
import { parseKey } from "../keys";
import { mulberry32 } from "../rng";
import { enumerateLocationKeys, materializeLocationQuestion } from "./location";

const byId = new Map(AOPS.map((a) => [a.id, a]));

/** direction の軸で「極側」ほど大きくなる座標値 */
function axisValue(aopId: string, direction: string): number {
	const [lng, lat] = getCentroid(aopId) ?? [0, 0];
	switch (direction) {
		case "north":
			return lat;
		case "south":
			return -lat;
		case "east":
			return lng;
		default:
			return -lng;
	}
}

const MIN_GAP = { north: 0.01, south: 0.01, east: 0.015, west: 0.015 } as const;

describe("位置関係クイズ", () => {
	it("全キーの全数スイープ: 正解が全誤答よりMIN_GAP以上極側・同一サブリージョンの村名のみ", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateLocationKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "location") throw new Error(key);
				const q = materializeLocationQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				const subjectValue = axisValue(q.correctOptionId, parsed.direction);
				for (const option of q.options) {
					const aop = byId.get(option.id);
					expect(aop?.kind, `${key} ${option.id}`).toBe("village");
					expect(aop?.subregionId, `${key} ${option.id}`).toBe(
						parsed.subregionId,
					);
					if (option.id === q.correctOptionId) continue;
					expect(
						subjectValue - axisValue(option.id, parsed.direction),
						`${key} ${option.id}`,
					).toBeGreaterThanOrEqual(MIN_GAP[parsed.direction]);
				}
			}
		}
	});

	it("村が4未満のサブリージョンでは生成されない(コート・デ・バール等)", () => {
		for (const regionId of REGION_IDS) {
			for (const key of enumerateLocationKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "location") continue;
				expect(parsed.subregionId, key).not.toBe("cote-des-bar");
				expect(parsed.subregionId, key).not.toBe("champagne-regional");
				expect(parsed.subregionId, key).not.toBe("bourgogne-regional");
			}
		}
	});

	it("各地域で1件以上生成される(MIN_GAP調整の回帰チェック)", () => {
		for (const regionId of REGION_IDS) {
			expect(enumerateLocationKeys(regionId).length, regionId).toBeGreaterThan(
				0,
			);
		}
	});

	it("コート・ド・ニュイ最北の代表問題が生成される", () => {
		const keys = enumerateLocationKeys("bourgogne");
		expect(keys).toContain("location:north:cote-de-nuits:marsannay");
	});
});
