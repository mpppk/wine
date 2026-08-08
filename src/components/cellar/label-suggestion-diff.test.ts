import { describe, expect, it } from "vitest";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { buildLabelDiffs } from "#/components/cellar/label-suggestion-diff";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";

// #362: 再解析(写真追加・エンジン切替)の結果を「未入力の項目にしか反映しない」と、
// 全項目入力済みの状態では何も変わらずクレジットだけ消費される。差分がある項目だけを
// 検出できることを固定する(現在値の有無を問わず、値が変わるかどうかで判定する)。

// 産地(aopId / regionId / countryId)はフォーム上「最も細かい1つだけ」を持つ(#374)。
// fixture もその不変条件を守る——両方入った値を基準にすると、排他を壊す実装でも
// テストが通ってしまう。
const EMPTY_VALUES: DrunkWineFieldsValue = {
	name: "",
	status: "finished",
	vintage: "",
	producer: "",
	price: "",
	aopId: undefined,
	regionId: undefined,
	countryId: undefined,
	grapeVarietyIds: [],
	note: "",
};

const FILLED_VALUES: DrunkWineFieldsValue = {
	name: "Chablis",
	status: "finished",
	vintage: "2018",
	producer: "Dauvissat",
	price: "3000",
	aopId: "chablis",
	regionId: undefined,
	countryId: undefined,
	grapeVarietyIds: ["chardonnay"],
	note: "白桃の香り",
};

describe("buildLabelDiffs", () => {
	it("全項目未入力なら、解析結果の全項目が差分になる", () => {
		const suggestions: LabelSuggestions = {
			name: "Chablis",
			producer: "Dauvissat",
			vintage: 2018,
			aopId: "chablis",
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
		};
		const diffs = buildLabelDiffs(EMPTY_VALUES, suggestions);
		expect(diffs.map((d) => d.key).sort()).toEqual(
			["grapeVarietyIds", "name", "producer", "provenance", "vintage"].sort(),
		);
		const name = diffs.find((d) => d.key === "name");
		expect(name?.current).toBe("(未入力)");
		expect(name?.suggested).toBe("Chablis");
		expect(name?.patch).toEqual({ name: "Chablis" });
	});

	it("全項目入力済みで解析結果が同じ値なら、差分は無い(#362の再現ケース)", () => {
		const suggestions: LabelSuggestions = {
			name: "Chablis",
			producer: "Dauvissat",
			vintage: 2018,
			aopId: "chablis",
			regionId: "bourgogne",
			grapeVarietyIds: ["chardonnay"],
		};
		expect(buildLabelDiffs(FILLED_VALUES, suggestions)).toEqual([]);
	});

	it("全項目入力済みでも、解析結果が異なれば差分として検出する(#362が解決したいケース)", () => {
		const suggestions: LabelSuggestions = {
			producer: "Domaine Dauvissat-Camus",
			vintage: 2019,
		};
		const diffs = buildLabelDiffs(FILLED_VALUES, suggestions);
		expect(diffs).toHaveLength(2);
		const producer = diffs.find((d) => d.key === "producer");
		expect(producer?.current).toBe("Dauvissat");
		expect(producer?.suggested).toBe("Domaine Dauvissat-Camus");
		const vintage = diffs.find((d) => d.key === "vintage");
		expect(vintage?.current).toBe("2018");
		expect(vintage?.suggested).toBe("2019");
	});

	it("産地は粒度によらず1項目にまとめ、AOP候補は最も細かい単位だけをpatchに入れる", () => {
		// buildLabelSuggestions は AOP を解決できたとき地域も併せて返す。
		// フォームは最も細かい1つだけを持つので aopId に畳む。
		const suggestions: LabelSuggestions = {
			aopId: "gevrey-chambertin",
			regionId: "bourgogne",
		};
		const diffs = buildLabelDiffs(FILLED_VALUES, suggestions);
		expect(diffs).toHaveLength(1);
		const provenance = diffs[0];
		expect(provenance?.key).toBe("provenance");
		expect(provenance?.current).toBe("シャブリ");
		expect(provenance?.suggested).toBe("ジュヴレ・シャンベルタン");
		expect(provenance?.patch).toEqual({
			aopId: "gevrey-chambertin",
			regionId: undefined,
			countryId: undefined,
		});
	});

	it("地域のみの候補(AOPが解決できなかった場合)は、既存のAOPを消して地域に置き換える", () => {
		const suggestions: LabelSuggestions = { regionId: "piemonte" };
		const diffs = buildLabelDiffs(FILLED_VALUES, suggestions);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.suggested).toBe("ピエモンテ");
		// aopId を undefined で明示的に消さないと「AOPと地域が同時に入る」状態になる
		expect(diffs[0]?.patch).toEqual({
			aopId: undefined,
			regionId: "piemonte",
			countryId: undefined,
		});
	});

	it("国のみの候補(地域も解決できなかった場合)も産地の差分として扱う(#374)", () => {
		const suggestions: LabelSuggestions = { countryId: "france" };
		const diffs = buildLabelDiffs(EMPTY_VALUES, suggestions);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.key).toBe("provenance");
		expect(diffs[0]?.current).toBe("(未入力)");
		expect(diffs[0]?.suggested).toBe("フランス");
		expect(diffs[0]?.patch).toEqual({
			aopId: undefined,
			regionId: undefined,
			countryId: "france",
		});
	});

	it("国単位で紐付け済みの状態にAOP候補を反映しても countryId が残らない(排他の回帰)", () => {
		const countryOnly: DrunkWineFieldsValue = {
			...EMPTY_VALUES,
			countryId: "france",
		};
		const diffs = buildLabelDiffs(countryOnly, { aopId: "chablis" });
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.current).toBe("フランス");
		expect(diffs[0]?.suggested).toBe("シャブリ");
		expect(diffs[0]?.patch).toEqual({
			aopId: "chablis",
			regionId: undefined,
			countryId: undefined,
		});
	});

	it("同じ産地が同じ粒度で入っていれば差分にしない", () => {
		expect(buildLabelDiffs(FILLED_VALUES, { aopId: "chablis" })).toEqual([]);
		const countryOnly: DrunkWineFieldsValue = {
			...EMPTY_VALUES,
			countryId: "france",
		};
		expect(buildLabelDiffs(countryOnly, { countryId: "france" })).toEqual([]);
	});

	it("ぶどう品種は集合として比較し、順序違いは差分にしない", () => {
		const values: DrunkWineFieldsValue = {
			...FILLED_VALUES,
			grapeVarietyIds: ["chardonnay", "pinot-noir"],
		};
		const same: LabelSuggestions = {
			grapeVarietyIds: ["pinot-noir", "chardonnay"],
		};
		expect(buildLabelDiffs(values, same)).toEqual([]);

		const changed: LabelSuggestions = { grapeVarietyIds: ["chardonnay"] };
		const diffs = buildLabelDiffs(values, changed);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.key).toBe("grapeVarietyIds");
		expect(diffs[0]?.suggested).toBe("シャルドネ");
	});

	it("解析結果に値が無い項目は差分にしない", () => {
		expect(buildLabelDiffs(FILLED_VALUES, {})).toEqual([]);
		expect(buildLabelDiffs(EMPTY_VALUES, {})).toEqual([]);
	});
});
