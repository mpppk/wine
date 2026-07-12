import { describe, expect, it } from "vitest";
import { buildDescriptionSegments } from "./description-links";
import type { Aop, Region } from "./types";

function aop(partial: Partial<Aop> & Pick<Aop, "id" | "kind">): Aop {
	return {
		idApp: 1,
		name: partial.id,
		shortName: partial.id,
		nameJa: partial.id,
		region: "beaujolais",
		subregionId: "sub-a",
		colors: ["red"],
		grapes: [{ varietyId: "gamay", role: "principal" }],
		soil: "-",
		producers: [{ name: "-" }],
		description: "-",
		...partial,
	};
}

function region(id: string, nameJa: string, enabled = true): Region {
	return {
		id,
		nameJa,
		nameLocal: id,
		country: "FR",
		countryJa: "フランス",
		enabled,
		subregions: [],
		description: "-",
	};
}

const CURRENT = aop({ id: "brouilly", kind: "village", nameJa: "ブルイィ" });
const AOPS: Aop[] = [
	CURRENT,
	aop({
		id: "cote-de-brouilly",
		kind: "village",
		nameJa: "コート・ド・ブルイィ",
	}),
	aop({ id: "fleurie", kind: "village", nameJa: "フルーリー" }),
	aop({
		id: "morgon",
		kind: "village",
		nameJa: "モルゴン",
		shortName: "モルゴン(短)",
	}),
];
const REGIONS: Region[] = [
	region("beaujolais", "ボジョレー"),
	region("bourgogne", "ブルゴーニュ"),
	region("champagne", "シャンパーニュ", false),
];

function build(description: string, current: Aop = CURRENT) {
	return buildDescriptionSegments(description, {
		currentAop: current,
		aops: AOPS,
		regions: REGIONS,
	});
}

describe("buildDescriptionSegments", () => {
	it("一致が無ければ全体を1つのテキストにする", () => {
		expect(build("親しみやすいスタイルの赤ワイン。")).toEqual([
			{ kind: "text", text: "親しみやすいスタイルの赤ワイン。" },
		]);
	});

	it("同地域の他AOP名をリンクセグメントにする", () => {
		expect(build("フルーリーに隣接する。")).toEqual([
			{ kind: "aop", text: "フルーリー", aopId: "fleurie" },
			{ kind: "text", text: "に隣接する。" },
		]);
	});

	it("最長一致で内側の短い名前を二重リンクしない", () => {
		// 「コート・ド・ブルイィ」を「ブルイィ」より優先して1つのリンクにする
		expect(build("コート・ド・ブルイィの斜面。")).toEqual([
			{
				kind: "aop",
				text: "コート・ド・ブルイィ",
				aopId: "cote-de-brouilly",
			},
			{ kind: "text", text: "の斜面。" },
		]);
	});

	it("自己名はリンクしない", () => {
		// currentAop 自身の nameJa「ブルイィ」は候補から除外される
		expect(build("ブルイィ山の裾野。")).toEqual([
			{ kind: "text", text: "ブルイィ山の裾野。" },
		]);
	});

	it("自地域名は除外し、他地域名はリンクする", () => {
		const segs = build("ボジョレーとブルゴーニュにまたがる。");
		// 自地域(beaujolais=ボジョレー)は素のテキスト、ブルゴーニュはリンク
		expect(segs).toEqual([
			{ kind: "text", text: "ボジョレーと" },
			{ kind: "region", text: "ブルゴーニュ", regionId: "bourgogne" },
			{ kind: "text", text: "にまたがる。" },
		]);
	});

	it("enabled でない地域はリンクしない", () => {
		expect(build("シャンパーニュ方式。")).toEqual([
			{ kind: "text", text: "シャンパーニュ方式。" },
		]);
	});

	it("shortName でも一致する", () => {
		expect(build("モルゴン(短)は力強い。")).toEqual([
			{ kind: "aop", text: "モルゴン(短)", aopId: "morgon" },
			{ kind: "text", text: "は力強い。" },
		]);
	});

	it("隣接する複数のリンクを連続で返す", () => {
		expect(build("フルーリーモルゴン")).toEqual([
			{ kind: "aop", text: "フルーリー", aopId: "fleurie" },
			{ kind: "aop", text: "モルゴン", aopId: "morgon" },
		]);
	});
});
