import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { aopClassificationLabel } from "#/lib/wine/tags";
import { parseKey } from "../keys";
import { mulberry32 } from "../rng";
import {
	enumerateAopClassificationKeys,
	materializeAopClassificationQuestion,
} from "./aop-classification";

const byId = new Map(AOPS.map((a) => [a.id, a]));

describe("格付けクイズ", () => {
	it("格付けタグを持つ全AOP分のキーが列挙される", () => {
		const total = REGION_IDS.flatMap((r) => enumerateAopClassificationKeys(r));
		const tagged = AOPS.filter((a) => aopClassificationLabel(a) !== undefined);
		expect(total.length).toBe(tagged.length);
		expect(new Set(total).size).toBe(total.length);
	});

	it("全キーの全数スイープ: 4択・重複なし・正解が対象AOPの格付けラベルと一致", () => {
		const rng = mulberry32(42);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateAopClassificationKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "aop-classification") throw new Error(key);
				const q = materializeAopClassificationQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				expect(q.options).toHaveLength(4);
				expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
				const aop = byId.get(q.subjectAopId);
				expect(aop, key).toBeDefined();
				if (!aop) continue;
				expect(q.correctOptionId).toBe(aopClassificationLabel(aop));
				expect(q.options.some((o) => o.id === q.correctOptionId)).toBe(true);
			}
		}
	});

	it("タグ無しAOPは主題にならない", () => {
		for (const regionId of REGION_IDS) {
			for (const key of enumerateAopClassificationKeys(regionId)) {
				const aop = byId.get(key.split(":")[1]);
				expect((aop?.tags?.length ?? 0) > 0, key).toBe(true);
			}
		}
	});

	it("固定RNGで決定的", () => {
		const parsed = {
			quizType: "aop-classification",
			aopId: "chambertin",
		} as const;
		const q1 = materializeAopClassificationQuestion(parsed, mulberry32(7));
		const q2 = materializeAopClassificationQuestion(parsed, mulberry32(7));
		expect(q1).toEqual(q2);
	});

	it("存在しないAOP・タグ無しAOPは null", () => {
		expect(
			materializeAopClassificationQuestion(
				{ quizType: "aop-classification", aopId: "no-such-aop" },
				mulberry32(1),
			),
		).toBeNull();
	});
});
