import { describe, expect, it } from "vitest";
import type { DrunkWineFieldsValue } from "#/components/cellar/drunk-wine-payload";
import { buildLabelDiffs } from "#/components/cellar/label-suggestion-diff";
import type { LabelSuggestions } from "#/lib/ai/label-extraction";

// #362: 再解析(写真追加・エンジン切替)の結果を「未入力の項目にしか反映しない」と、
// 全項目入力済みの状態では何も変わらずクレジットだけ消費される。差分がある項目だけを
// 検出できることを固定する(現在値の有無を問わず、値が変わるかどうかで判定する)。

const EMPTY_VALUES: DrunkWineFieldsValue = {
	name: "",
	status: "finished",
	vintage: "",
	producer: "",
	price: "",
	aopId: undefined,
	regionId: undefined,
	grapeVarietyIds: [],
};

const FILLED_VALUES: DrunkWineFieldsValue = {
	name: "Chablis",
	status: "finished",
	vintage: "2018",
	producer: "Dauvissat",
	price: "3000",
	aopId: "chablis",
	regionId: "bourgogne",
	grapeVarietyIds: ["chardonnay"],
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
			["grapeVarietyIds", "name", "producer", "region", "vintage"].sort(),
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

	it("地域とAOPは1項目にまとめ、表示名で示す", () => {
		const suggestions: LabelSuggestions = {
			aopId: "gevrey-chambertin",
			regionId: "bourgogne",
		};
		const diffs = buildLabelDiffs(FILLED_VALUES, suggestions);
		expect(diffs).toHaveLength(1);
		const region = diffs[0];
		expect(region?.key).toBe("region");
		expect(region?.current).toContain("シャブリ");
		expect(region?.suggested).toContain("ジュヴレ・シャンベルタン");
		expect(region?.patch).toEqual({
			aopId: "gevrey-chambertin",
			regionId: "bourgogne",
		});
	});

	it("地域のみの候補(AOPが解決できなかった場合)は地域だけpatchに含む", () => {
		const suggestions: LabelSuggestions = { regionId: "piemonte" };
		const diffs = buildLabelDiffs(FILLED_VALUES, suggestions);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]?.patch).toEqual({ regionId: "piemonte" });
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
