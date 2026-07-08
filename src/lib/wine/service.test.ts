import { describe, expect, it } from "vitest";
import {
	aopAllowsGrape,
	getAop,
	getRegion,
	listAops,
	listRegions,
} from "./service";

describe("listRegions", () => {
	it("有効な地域にAOP数が付く", () => {
		const regions = listRegions();
		const bourgogne = regions.find((r) => r.id === "bourgogne");
		expect(bourgogne).toBeDefined();
		expect(bourgogne?.enabled).toBe(true);
		expect(bourgogne?.aopCount ?? 0).toBeGreaterThan(0);
	});

	it("準備中の地域も一覧に含まれる", () => {
		const regions = listRegions();
		expect(regions.some((r) => !r.enabled)).toBe(true);
	});
});

describe("listAops", () => {
	it("地域で絞り込める", () => {
		const aops = listAops({ regionId: "bourgogne" });
		expect(aops.length).toBeGreaterThan(0);
		expect(aops.every((a) => a.region === "bourgogne")).toBe(true);
	});

	it("品種フィルタは許可されたAOPのみ返す", () => {
		const all = listAops({ regionId: "bourgogne" });
		const chardonnayOnly = listAops({
			regionId: "bourgogne",
			grapeVarietyId: "chardonnay",
		});
		expect(chardonnayOnly.length).toBeGreaterThan(0);
		expect(chardonnayOnly.length).toBeLessThanOrEqual(all.length);
		for (const aop of chardonnayOnly) {
			expect(aopAllowsGrape(aop, "chardonnay")).toBe(true);
		}
	});

	it("存在しない品種では0件になる", () => {
		expect(listAops({ grapeVarietyId: "no-such-grape" })).toHaveLength(0);
	});

	it("格付けで絞り込める", () => {
		const aops = listAops({
			regionId: "bourgogne",
			classification: "village",
		});
		expect(aops.every((a) => a.classification === "village")).toBe(true);
	});

	it("シャンパーニュは広域2+グラン・クリュ17+プルミエ・クリュ42+村名1を返す", () => {
		const aops = listAops({ regionId: "champagne" });
		expect(aops).toHaveLength(62);
		expect(aops.filter((a) => a.classification === "regional")).toHaveLength(2);
		expect(aops.filter((a) => a.classification === "grand-cru")).toHaveLength(
			17,
		);
		expect(
			aops.filter((a) => a.classification === "village" && a.premierCru),
		).toHaveLength(42);
		expect(
			aops.filter((a) => a.classification === "village" && !a.premierCru),
		).toHaveLength(1);
	});

	it("ムニエでシャンパーニュのAOPを絞り込める", () => {
		const aops = listAops({ regionId: "champagne", grapeVarietyId: "meunier" });
		expect(aops.length).toBeGreaterThan(0);
		for (const aop of aops) {
			expect(aopAllowsGrape(aop, "meunier")).toBe(true);
		}
	});
});

describe("getAop / getRegion", () => {
	it("スラッグでAOPを引ける", () => {
		const chablis = getAop("chablis");
		expect(chablis?.nameJa).toBe("シャブリ");
	});

	it("未知のIDはundefined", () => {
		expect(getAop("no-such-aop")).toBeUndefined();
		expect(getRegion("no-such-region")).toBeUndefined();
	});
});
