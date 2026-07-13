import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { buildGrandCruOddKey, parseKey } from "../keys";
import { mulberry32 } from "../rng";
import {
	enumerateGrandCruOddKeys,
	materializeGrandCruOddQuestion,
} from "./grand-cru-odd";

const byId = new Map(AOPS.map((a) => [a.id, a]));

function isGrandCru(id: string): boolean {
	return byId.get(id)?.tags?.includes("grand-cru") ?? false;
}

describe("特級の仲間外れクイズ(grand-cru-odd)", () => {
	it("全キーの全数スイープ: 正解だけが非特級、他3つは同地区の特級", () => {
		const rng = mulberry32(42);
		let count = 0;
		for (const regionId of REGION_IDS) {
			for (const key of enumerateGrandCruOddKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "grand-cru-odd") throw new Error(key);
				const q = materializeGrandCruOddQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				count++;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				const answerAop = byId.get(q.correctOptionId);
				expect(answerAop, key).toBeDefined();
				for (const option of q.options) {
					const aop = byId.get(option.id);
					expect(aop, `${key} option ${option.id}`).toBeDefined();
					if (!aop) continue;
					// 正解のみ非特級、他3つは特級
					expect(isGrandCru(option.id), `${key} option ${option.id}`).toBe(
						option.id !== q.correctOptionId,
					);
					expect(aop.subregionId, `${key} option ${option.id}`).toBe(
						answerAop?.subregionId,
					);
				}
				// 正解(仲間外れ)は一級の非特級
				expect(answerAop?.tags?.includes("premier-cru") ?? false, key).toBe(
					true,
				);
			}
		}
		expect(count).toBeGreaterThan(0);
	});

	it("出題対象はブルゴーニュのみ(他地域は0問)", () => {
		for (const regionId of REGION_IDS) {
			const keys = enumerateGrandCruOddKeys(regionId);
			if (regionId === "bourgogne") expect(keys.length).toBeGreaterThan(0);
			else expect(keys, regionId).toHaveLength(0);
		}
	});

	it("シャブリの仲間外れは一級クリマで、特級側は7つの特級クリマから出る", () => {
		const rng = mulberry32(7);
		const chablisGcClimats = new Set([
			"chablis-gc-les-clos",
			"chablis-gc-vaudesir",
			"chablis-gc-valmur",
			"chablis-gc-grenouilles",
			"chablis-gc-blanchot",
			"chablis-gc-bougros",
			"chablis-gc-preuses",
		]);
		let seen = 0;
		for (const key of enumerateGrandCruOddKeys("bourgogne")) {
			const parsed = parseKey(key);
			if (parsed?.quizType !== "grand-cru-odd") continue;
			const answer = byId.get(parsed.aopId);
			if (answer?.subregionId !== "chablis-grand-auxerrois") continue;
			seen++;
			expect(answer?.tags?.includes("premier-cru") ?? false, key).toBe(true);
			const q = materializeGrandCruOddQuestion(parsed, rng);
			for (const option of q?.options ?? []) {
				if (option.id === q?.correctOptionId) continue;
				expect(chablisGcClimats.has(option.id), `${key} distractor`).toBe(true);
			}
		}
		expect(seen).toBeGreaterThan(0);
	});

	it("コート・ド・ニュイ: 「ジュヴレ・シャンベルタン(村)」を仲間外れに、特級畑3つと並べられる", () => {
		const rng = mulberry32(11);
		const key = buildGrandCruOddKey("gevrey-chambertin");
		const parsed = parseKey(key);
		if (parsed?.quizType !== "grand-cru-odd") throw new Error(key);
		// 列挙対象に含まれること
		expect(enumerateGrandCruOddKeys("bourgogne")).toContain(key);
		const q = materializeGrandCruOddQuestion(parsed, rng);
		expect(q, key).not.toBeNull();
		expect(q?.correctOptionId).toBe("gevrey-chambertin");
		for (const option of q?.options ?? []) {
			if (option.id === "gevrey-chambertin") continue;
			expect(isGrandCru(option.id), `distractor ${option.id}`).toBe(true);
			expect(byId.get(option.id)?.subregionId).toBe("cote-de-nuits");
		}
	});
});
