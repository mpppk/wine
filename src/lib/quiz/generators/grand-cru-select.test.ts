import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { parseKey } from "../keys";
import { mulberry32 } from "../rng";
import {
	enumerateGrandCruSelectKeys,
	materializeGrandCruSelectQuestion,
} from "./grand-cru-select";

const byId = new Map(AOPS.map((a) => [a.id, a]));

function isGrandCru(id: string): boolean {
	return byId.get(id)?.tags?.includes("grand-cru") ?? false;
}

describe("特級を選ぶクイズ(grand-cru-select)", () => {
	it("全キーの全数スイープ: 正解だけが特級、他3つは同地区の非特級", () => {
		const rng = mulberry32(42);
		let count = 0;
		for (const regionId of REGION_IDS) {
			for (const key of enumerateGrandCruSelectKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "grand-cru-select") throw new Error(key);
				const q = materializeGrandCruSelectQuestion(parsed, rng);
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
					// 正解のみ特級、他は非特級
					expect(isGrandCru(option.id), `${key} option ${option.id}`).toBe(
						option.id === q.correctOptionId,
					);
					// 全選択肢が正解と同一地区
					expect(aop.subregionId, `${key} option ${option.id}`).toBe(
						answerAop?.subregionId,
					);
				}
			}
		}
		expect(count).toBeGreaterThan(0);
	});

	it("出題対象はブルゴーニュのみ(他地域は0問)", () => {
		for (const regionId of REGION_IDS) {
			const keys = enumerateGrandCruSelectKeys(regionId);
			if (regionId === "bourgogne") expect(keys.length).toBeGreaterThan(0);
			else expect(keys, regionId).toHaveLength(0);
		}
	});

	it("シャブリの正解は7つの特級クリマで、傘AOC(Chablis Grand Cru/Premier Cru)は選択肢に出ない", () => {
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
		const answers = new Set<string>();
		for (const key of enumerateGrandCruSelectKeys("bourgogne")) {
			const parsed = parseKey(key);
			if (parsed?.quizType !== "grand-cru-select") continue;
			const answer = byId.get(parsed.aopId);
			if (answer?.subregionId !== "chablis-grand-auxerrois") continue;
			answers.add(parsed.aopId);
			const q = materializeGrandCruSelectQuestion(parsed, rng);
			for (const option of q?.options ?? []) {
				expect(option.id).not.toBe("chablis-grand-cru");
				expect(option.id).not.toBe("chablis-premier-cru");
			}
		}
		expect(answers).toEqual(chablisGcClimats);
	});

	it("ブルゴーニュのディストラクタは一級(premier-cru)を優先する", () => {
		const rng = mulberry32(3);
		for (const key of enumerateGrandCruSelectKeys("bourgogne")) {
			const parsed = parseKey(key);
			if (parsed?.quizType !== "grand-cru-select") continue;
			const q = materializeGrandCruSelectQuestion(parsed, rng);
			for (const option of q?.options ?? []) {
				if (option.id === q?.correctOptionId) continue;
				expect(
					byId.get(option.id)?.tags?.includes("premier-cru") ?? false,
					`${key} distractor ${option.id}`,
				).toBe(true);
			}
		}
	});

	it("特級を持たない地区(コート・シャロネーズ/マコネ)は出題対象にならない", () => {
		const subregions = new Set<string>();
		for (const key of enumerateGrandCruSelectKeys("bourgogne")) {
			const parsed = parseKey(key);
			if (parsed?.quizType !== "grand-cru-select") continue;
			const sub = byId.get(parsed.aopId)?.subregionId;
			if (sub) subregions.add(sub);
		}
		expect(subregions.has("cote-chalonnaise")).toBe(false);
		expect(subregions.has("maconnais")).toBe(false);
	});
});
