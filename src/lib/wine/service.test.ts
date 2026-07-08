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

	it("区分(kind)で絞り込める", () => {
		const aops = listAops({ regionId: "bourgogne", kind: "village" });
		expect(aops.length).toBeGreaterThan(0);
		expect(aops.every((a) => a.kind === "village")).toBe(true);
	});

	it("タグで絞り込める(OR結合)", () => {
		const grandCrus = listAops({ regionId: "bourgogne", tags: ["grand-cru"] });
		expect(grandCrus).toHaveLength(33);
		expect(grandCrus.every((a) => a.tags?.includes("grand-cru"))).toBe(true);

		const crus = listAops({
			regionId: "bourgogne",
			tags: ["grand-cru", "premier-cru"],
		});
		// 特級33 + 一級区画を持つ村31 の和集合(両タグ併持は無い)
		expect(crus).toHaveLength(64);
		expect(
			crus.every((a) =>
				a.tags?.some((t) => t === "grand-cru" || t === "premier-cru"),
			),
		).toBe(true);
	});

	it("区分とタグの複合はANDで絞り込む", () => {
		const aops = listAops({
			regionId: "champagne",
			kind: "village",
			tags: ["grand-cru"],
		});
		expect(aops).toHaveLength(17);
		expect(
			aops.every((a) => a.kind === "village" && a.tags?.includes("grand-cru")),
		).toBe(true);
	});

	it("シャンパーニュは広域2+特級村17+一級村42+タグなし村1を返す", () => {
		const aops = listAops({ regionId: "champagne" });
		expect(aops).toHaveLength(62);
		expect(aops.filter((a) => a.kind === "regional")).toHaveLength(2);
		// 特級・一級はいずれも村の格付け(échelle des crus)なので kind は village
		expect(aops.filter((a) => a.kind === "vineyard")).toHaveLength(0);
		expect(aops.filter((a) => a.tags?.includes("grand-cru"))).toHaveLength(17);
		expect(aops.filter((a) => a.tags?.includes("premier-cru"))).toHaveLength(
			42,
		);
		expect(
			aops.filter((a) => a.kind === "village" && !a.tags?.length),
		).toHaveLength(1);
	});

	it("ムニエでシャンパーニュのAOPを絞り込める", () => {
		const aops = listAops({ regionId: "champagne", grapeVarietyId: "meunier" });
		expect(aops.length).toBeGreaterThan(0);
		for (const aop of aops) {
			expect(aopAllowsGrape(aop, "meunier")).toBe(true);
		}
	});

	it("ボルドーは地方名6 + 村名12のAOCを持つ", () => {
		const aops = listAops({ regionId: "bordeaux" });
		expect(aops.filter((a) => a.kind === "regional")).toHaveLength(6);
		expect(aops.filter((a) => a.kind === "village")).toHaveLength(12);
		// 畑(vineyard)はボルドーには無い
		expect(aops.filter((a) => a.kind === "vineyard")).toHaveLength(0);
	});

	it("メルロでボルドーの右岸・広域AOPを絞り込める", () => {
		const aops = listAops({ regionId: "bordeaux", grapeVarietyId: "merlot" });
		expect(aops.length).toBeGreaterThan(0);
		expect(aops.some((a) => a.id === "pomerol")).toBe(true);
		for (const aop of aops) {
			expect(aopAllowsGrape(aop, "merlot")).toBe(true);
		}
	});

	it("ソーテルヌ・バルサックは甘口白(sweet-white)", () => {
		for (const id of ["sauternes", "barsac"]) {
			const aop = getAop(id);
			expect(aop?.colors).toEqual(["sweet-white"]);
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
