import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { aopClassificationLabel } from "#/lib/wine/tags";
import { duplicatesParentFact, isOpenEndedAppellation } from "./aop-pool";
import { enumerateAopVarietyKeys } from "./generators/aop-variety";
import { enumerateColorsKeys } from "./generators/colors";
import { enumerateVarietyKeys } from "./generators/variety";
import { parseKey } from "./keys";
import { colorComboId } from "./labels";

const igtAopIds = new Set(
	AOPS.filter((a) => isOpenEndedAppellation(a)).map((a) => a.id),
);

describe("開かれた広域呼称(IGT)の出題除外", () => {
	it("IGTのAOPが実在する(データが消えたら以下のテストは無意味)", () => {
		expect([...igtAopIds]).toEqual(["toscana-igt"]);
	});

	// IGT の生産規約は「州で栽培が認められた品種」を丸ごと許すため、aops.json の
	// grapes / colors は代表例であって網羅ではない。網羅を前提に真偽を主張する
	// 形式に載せると事実と違う設問・解説になる(#212)。
	it.each([
		["colors", enumerateColorsKeys],
		["aop-variety", enumerateAopVarietyKeys],
		["variety", enumerateVarietyKeys],
	] as const)("%s の候補キーにIGTのAOPが現れない", (_name, enumerate) => {
		for (const regionId of REGION_IDS) {
			for (const key of enumerate(regionId)) {
				const parsed = parseKey(key);
				expect(igtAopIds.has(parsed?.aopId ?? ""), key).toBe(false);
			}
		}
	});

	// 逆に、格付けクイズは「その呼称の格付けは何か」を問うだけで品種・色を
	// 主張しないので IGT も扱える。ラベルが引けることを固定しておく(#212)。
	it("格付けラベルとしては IGT が引ける", () => {
		const igt = AOPS.find((a) => a.id === "toscana-igt");
		expect(igt && aopClassificationLabel(igt)).toBe("IGT");
	});
});

describe("親畑と同一内容の設問の集約(duplicatesParentFact)", () => {
	const byId = new Map(AOPS.map((a) => [a.id, a]));
	const aopOf = (id: string) => {
		const aop = byId.get(id);
		if (!aop) throw new Error(`no such aop: ${id}`);
		return aop;
	};

	it("値が親畑と同じクリマは true(シャブリGCのクリマの色)", () => {
		expect(
			duplicatesParentFact(aopOf("chablis-gc-les-clos"), (a) =>
				colorComboId(a.colors),
			),
		).toBe(true);
	});

	it("値が親畑と異なるクリマは false(コルトンの赤のみクリマの色)", () => {
		expect(
			duplicatesParentFact(aopOf("corton-les-bressandes"), (a) =>
				colorComboId(a.colors),
			),
		).toBe(false);
	});

	it("parentAopId を持たないAOPは常に false", () => {
		expect(
			duplicatesParentFact(aopOf("chablis-grand-cru"), (a) =>
				colorComboId(a.colors),
			),
		).toBe(false);
	});

	it("事実が undefined / 空のときは false(比較不能なら除外しない)", () => {
		expect(
			duplicatesParentFact(aopOf("chablis-gc-les-clos"), () => undefined),
		).toBe(false);
		expect(duplicatesParentFact(aopOf("chablis-gc-les-clos"), () => "")).toBe(
			false,
		);
	});
});
