import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { getCentroid } from "#/lib/wine/centroids";
import { getRegion, REGION_IDS } from "#/lib/wine/regions";
import { listAops } from "#/lib/wine/service";
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
	it("全キーの全数スイープ: 正解が全誤答よりMIN_GAP以上極側・同一サブリージョン/同一区分のみ", () => {
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
				// 村名AOCを持たない地域(アルザス等)は畑名AOPで出題される。
				// 1問の中で村と畑は混ざらない(全選択肢が正解と同一区分)。
				const subjectKind = byId.get(q.correctOptionId)?.kind;
				expect(["village", "vineyard"], key).toContain(subjectKind);
				for (const option of q.options) {
					const aop = byId.get(option.id);
					expect(aop?.kind, `${key} ${option.id}`).toBe(subjectKind);
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

	// 位置関係クイズは同一地区の村名AOP(無ければ畑名AOP)を4件以上必要とする。
	// スペインのようにDO(=地方名AOP)が呼称の単位になる地域はこの条件を満たさず、
	// 構造的に出題されない。地方名AOP同士は入れ子(ミュスカデ ⊃ ミュスカデ・
	// セーヴル・エ・メーヌ)になりうるため代替の出題対象にもできない。
	// そこで「対象になりうる地域だけ」を対象にしてMIN_GAPの回帰を見る。
	const regionsWithLocationPool = REGION_IDS.filter((regionId) =>
		getRegion(regionId)?.subregions.some(
			(s) =>
				listAops({ regionId, subregionId: s.id, kind: "village" }).length >=
					4 ||
				listAops({ regionId, subregionId: s.id, kind: "vineyard" }).length >= 4,
		),
	);

	it("出題対象になりうる地域では1件以上生成される(MIN_GAP調整の回帰チェック)", () => {
		expect(regionsWithLocationPool.length).toBeGreaterThan(0);
		for (const regionId of regionsWithLocationPool) {
			expect(enumerateLocationKeys(regionId).length, regionId).toBeGreaterThan(
				0,
			);
		}
	});

	it("村名/畑名AOPを4件持つ地区が無い地域では生成されない(スペイン)", () => {
		expect(regionsWithLocationPool).not.toContain("rioja");
		expect(enumerateLocationKeys("rioja")).toEqual([]);
	});

	it("コート・ド・ニュイ最北の代表問題が生成される", () => {
		const keys = enumerateLocationKeys("bourgogne");
		expect(keys).toContain("location:north:cote-de-nuits:marsannay");
	});
});
