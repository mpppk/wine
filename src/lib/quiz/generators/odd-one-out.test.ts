import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { aopAllowsGrape } from "#/lib/wine/service";
import { AOP_TAG_LABELS_JA } from "#/lib/wine/tags";
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

	// Issue #25 の回帰テスト群。

	// 格付け軸として成立するタグ(実装のホワイトリストとは独立にテスト側で定義)。
	const ALLOWED_TAG_AXES = new Set(["grand-cru", "premier-cru", "docg"]);

	it("tag軸は成立する格付け(特級/一級/DOCG)だけを出題する", () => {
		for (const regionId of REGION_IDS) {
			for (const key of enumerateOddOneOutKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "odd-one-out" || parsed.axis !== "tag")
					continue;
				// doc(上位DOCGが正解になり誤誘導)・1855年格付け/サンテミリオン特別級
				// (シャトー格付けで kind 不一致)は列挙されない
				expect(ALLOWED_TAG_AXES.has(parsed.axisValue), key).toBe(true);
			}
		}
	});

	it("tag軸の設問文・解説に軸の格付け名が入り、誤ったグラン・クリュ定型文に落ちない", () => {
		const rng = mulberry32(7);
		for (const regionId of REGION_IDS) {
			for (const key of enumerateOddOneOutKeys(regionId)) {
				const parsed = parseKey(key);
				if (parsed?.quizType !== "odd-one-out" || parsed.axis !== "tag")
					continue;
				// premier-cru は「一級 / 1er Cru」の文言を別テストで検証済み
				if (parsed.axisValue === "premier-cru") continue;
				const q = materializeOddOneOutQuestion(parsed, rng);
				expect(q, key).not.toBeNull();
				if (!q) continue;
				const label =
					AOP_TAG_LABELS_JA[parsed.axisValue as keyof typeof AOP_TAG_LABELS_JA];
				expect(q.prompt.includes(label), `${key} prompt=${q.prompt}`).toBe(
					true,
				);
				expect(q.explanation.includes(label), `${key} expl`).toBe(true);
				// DOCG 等の非特級タグが「グラン・クリュ」定型文へ落ちていないこと
				if (parsed.axisValue !== "grand-cru") {
					expect(q.prompt.includes("グラン・クリュ"), `${key} prompt`).toBe(
						false,
					);
					expect(q.explanation.includes("グラン・クリュ"), `${key} expl`).toBe(
						false,
					);
				}
			}
		}
	});

	it("ピエモンテで docg 軸の仲間外れが生成される(過剰除外の回帰防止)", () => {
		const docgKeys = enumerateOddOneOutKeys("piemonte").filter((key) => {
			const parsed = parseKey(key);
			return (
				parsed?.quizType === "odd-one-out" &&
				parsed.axis === "tag" &&
				parsed.axisValue === "docg"
			);
		});
		expect(docgKeys.length).toBeGreaterThan(0);
	});
});
