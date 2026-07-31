import { describe, expect, it } from "vitest";
import {
	CELLAR_FILTER_IDS,
	countCellarFilters,
	DEFAULT_CELLAR_FILTER,
	matchesCellarFilter,
} from "./filter";
import { WINE_STATUS_IDS, type WineStatus } from "./status";

describe("matchesCellarFilter", () => {
	it("既定はすべて表示", () => {
		expect(DEFAULT_CELLAR_FILTER).toBe("all");
	});

	// 5フィルタ × 4状態 × 飲用件数 {0,1,2} の全60通りを固定する。
	// 「所有状態」と「飲んだことがあるか」は独立した2軸なので、組み合わせを
	// 網羅しないと「以前飲んで、また買った」(owned かつ tastingCount>0)の
	// ような交差ケースが落ちる。
	//
	// spotted(見かけた)も所有状態の一種なので、tasted とは独立に該当しうる
	// (店で見かけて、その場で1杯飲んだ = spotted かつ tastingCount>0)。
	const expected: Record<string, boolean> = {
		// all は常に true
		"all/wishlist/0": true,
		"all/wishlist/1": true,
		"all/wishlist/2": true,
		"all/owned/0": true,
		"all/owned/1": true,
		"all/owned/2": true,
		"all/finished/0": true,
		"all/finished/1": true,
		"all/finished/2": true,
		"all/spotted/0": true,
		"all/spotted/1": true,
		"all/spotted/2": true,
		// tasted は飲用件数だけを見る
		"tasted/wishlist/0": false,
		"tasted/wishlist/1": true,
		"tasted/wishlist/2": true,
		"tasted/owned/0": false,
		"tasted/owned/1": true,
		"tasted/owned/2": true,
		"tasted/finished/0": false,
		"tasted/finished/1": true,
		"tasted/finished/2": true,
		"tasted/spotted/0": false,
		"tasted/spotted/1": true,
		"tasted/spotted/2": true,
		// owned / wishlist / spotted は所有状態だけを見る
		"owned/wishlist/0": false,
		"owned/wishlist/1": false,
		"owned/wishlist/2": false,
		"owned/owned/0": true,
		"owned/owned/1": true,
		"owned/owned/2": true,
		"owned/finished/0": false,
		"owned/finished/1": false,
		"owned/finished/2": false,
		"owned/spotted/0": false,
		"owned/spotted/1": false,
		"owned/spotted/2": false,
		"wishlist/wishlist/0": true,
		"wishlist/wishlist/1": true,
		"wishlist/wishlist/2": true,
		"wishlist/owned/0": false,
		"wishlist/owned/1": false,
		"wishlist/owned/2": false,
		"wishlist/finished/0": false,
		"wishlist/finished/1": false,
		"wishlist/finished/2": false,
		"wishlist/spotted/0": false,
		"wishlist/spotted/1": false,
		"wishlist/spotted/2": false,
		"spotted/wishlist/0": false,
		"spotted/wishlist/1": false,
		"spotted/wishlist/2": false,
		"spotted/owned/0": false,
		"spotted/owned/1": false,
		"spotted/owned/2": false,
		"spotted/finished/0": false,
		"spotted/finished/1": false,
		"spotted/finished/2": false,
		"spotted/spotted/0": true,
		"spotted/spotted/1": true,
		"spotted/spotted/2": true,
	};

	it("全60通りの組み合わせが期待どおり", () => {
		for (const filter of CELLAR_FILTER_IDS) {
			for (const status of WINE_STATUS_IDS) {
				for (const tastingCount of [0, 1, 2]) {
					const key = `${filter}/${status}/${tastingCount}`;
					expect(
						matchesCellarFilter({ status, tastingCount }, filter),
						key,
					).toBe(expected[key]);
				}
			}
		}
	});

	it("以前飲んで買い直したワインは tasted と owned の両方に該当する", () => {
		const entry = { status: "owned" as WineStatus, tastingCount: 1 };
		expect(matchesCellarFilter(entry, "tasted")).toBe(true);
		expect(matchesCellarFilter(entry, "owned")).toBe(true);
	});
});

describe("countCellarFilters", () => {
	it("空なら全て0", () => {
		expect(countCellarFilters([])).toEqual({
			all: 0,
			tasted: 0,
			owned: 0,
			wishlist: 0,
			spotted: 0,
		});
	});

	it("1本が複数のチップに数えられる(排他ではない)", () => {
		const counts = countCellarFilters([
			{ status: "owned", tastingCount: 1 }, // tasted + owned
			{ status: "wishlist", tastingCount: 0 },
			{ status: "finished", tastingCount: 3 },
			{ status: "spotted", tastingCount: 1 }, // tasted + spotted(店で見かけて1杯飲んだ)
		]);
		expect(counts).toEqual({
			all: 4,
			tasted: 3,
			owned: 1,
			wishlist: 1,
			spotted: 1,
		});
	});
});
