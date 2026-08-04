import { describe, expect, it } from "vitest";
import { AOPS } from "#/lib/wine/aops-data";
import { REGION_IDS } from "#/lib/wine/regions";
import { aopClassificationLabel } from "#/lib/wine/tags";
import type { Aop } from "#/lib/wine/types";
import { duplicatesUmbrellaFact, isOpenEndedAppellation } from "./aop-pool";
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

describe("上位AOPと同一内容の設問の集約(duplicatesUmbrellaFact)", () => {
	const byId = new Map(AOPS.map((a) => [a.id, a]));
	const aopOf = (id: string) => {
		const aop = byId.get(id);
		if (!aop) throw new Error(`no such aop: ${id}`);
		return aop;
	};
	const colorsOf = (a: Aop) => colorComboId(a.colors);

	it("値が親畑と同じクリマは true(シャブリGCのクリマの色)", () => {
		expect(duplicatesUmbrellaFact(aopOf("chablis-gc-les-clos"), colorsOf)).toBe(
			true,
		);
	});

	it("値が親畑と異なるクリマは false(コルトンの赤のみクリマの色)", () => {
		expect(
			duplicatesUmbrellaFact(aopOf("corton-les-bressandes"), colorsOf),
		).toBe(false);
	});

	// #436: シャンベルタン群は法的な親AOCを持たず villageAopIds で村に繋がるため、
	// parentAopId だけを見ていた #373 の集約から漏れていた。
	it("値が村と同じ独立AOCの畑も true(シャンベルタンの色)", () => {
		expect(duplicatesUmbrellaFact(aopOf("chambertin"), colorsOf)).toBe(true);
		expect(duplicatesUmbrellaFact(aopOf("romanee-conti"), colorsOf)).toBe(true);
	});

	it("値が村と異なる畑は false(ミュジニーは赤・白でシャンボールは赤のみ)", () => {
		expect(duplicatesUmbrellaFact(aopOf("musigny"), colorsOf)).toBe(false);
	});

	// 複数村にまたがる畑は全村一致のときだけ集約する。一村でも違えばその村のスコープで
	// 固有の事実になり、集約するとその村から学びが消える。
	it("複数村にまたがる畑は、一村でも値が違えば false(ボンヌ・マールの色)", () => {
		// シャンボール・ミュジニー(赤のみ)とは一致するが、モレ・サン・ドニは赤・白
		expect(duplicatesUmbrellaFact(aopOf("bonnes-mares"), colorsOf)).toBe(false);
	});

	it("複数村にまたがる畑でも全村と一致すれば true(ボンヌ・マールの地区)", () => {
		expect(
			duplicatesUmbrellaFact(aopOf("bonnes-mares"), (a) => a.subregionId),
		).toBe(true);
	});

	it("階層エッジを持たないAOPは常に false", () => {
		expect(duplicatesUmbrellaFact(aopOf("gevrey-chambertin"), colorsOf)).toBe(
			false,
		);
	});

	it("事実が undefined / 空のときは false(比較不能なら除外しない)", () => {
		expect(
			duplicatesUmbrellaFact(aopOf("chablis-gc-les-clos"), () => undefined),
		).toBe(false);
		expect(duplicatesUmbrellaFact(aopOf("chablis-gc-les-clos"), () => "")).toBe(
			false,
		);
	});

	// 集約は「上位側が同型の1問を出す」ことが前提。上位が出題対象外(fact が undefined)
	// なら集約先が無く、集約すると事実がどこからも出題されなくなる。
	it("上位が出題対象外(undefined)なら集約しない", () => {
		expect(
			duplicatesUmbrellaFact(aopOf("chablis-gc-les-clos"), (a) =>
				a.id === "chablis-grand-cru" ? undefined : colorComboId(a.colors),
			),
		).toBe(false);
	});
});
