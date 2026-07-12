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
	it("自地域だけで4択を作れる地域(実在ラベル4種以上)のAOPのみ列挙される", () => {
		// 地域ごとの実在格付けラベル数を数え、4種以上ある地域のタグ付きAOPだけが
		// 主題になる(制度をまたぐディストラクタ補充を廃止したため)。
		const labelsByRegion = new Map<string, Set<string>>();
		for (const a of AOPS) {
			const label = aopClassificationLabel(a);
			if (!label) continue;
			const set = labelsByRegion.get(a.region) ?? new Set<string>();
			set.add(label);
			labelsByRegion.set(a.region, set);
		}
		const total = REGION_IDS.flatMap((r) => enumerateAopClassificationKeys(r));
		const expected = AOPS.filter(
			(a) =>
				aopClassificationLabel(a) !== undefined &&
				(labelsByRegion.get(a.region)?.size ?? 0) >= 4,
		);
		expect(total.length).toBe(expected.length);
		expect(total.length).toBeGreaterThan(0);
		expect(new Set(total).size).toBe(total.length);
	});

	it("同一問題のディストラクタは対象AOPと同一地域の実在ラベルだけ", () => {
		const rng = mulberry32(99);
		for (const regionId of REGION_IDS) {
			const regionLabels = new Set(
				AOPS.filter((a) => a.region === regionId)
					.map((a) => aopClassificationLabel(a))
					.filter((l): l is string => l !== undefined),
			);
			for (const key of enumerateAopClassificationKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "aop-classification") throw new Error(key);
				const q = materializeAopClassificationQuestion(parsed, rng);
				if (!q) continue;
				for (const opt of q.options) {
					expect(regionLabels.has(opt.id), `${key} / ${opt.id}`).toBe(true);
				}
			}
		}
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
		// ボルドー(4ラベル以上)のシャトーを主題にする。ラベル数の少ない地域は
		// 本形式の出題対象外(null)になるため、非nullで比較できる地域を使う。
		const parsed = {
			quizType: "aop-classification",
			aopId: "chateau-margaux",
		} as const;
		const q1 = materializeAopClassificationQuestion(parsed, mulberry32(7));
		const q2 = materializeAopClassificationQuestion(parsed, mulberry32(7));
		expect(q1).not.toBeNull();
		expect(q1).toEqual(q2);
	});

	it("ラベル数の少ない地域(ブルゴーニュ等)は主題にしても null", () => {
		// 制度をまたぐディストラクタ補充を廃止したため、自地域で4択を作れない
		// 地域のAOPは出題されない(chambertin はブルゴーニュのグラン・クリュ)。
		expect(
			materializeAopClassificationQuestion(
				{ quizType: "aop-classification", aopId: "chambertin" },
				mulberry32(7),
			),
		).toBeNull();
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
