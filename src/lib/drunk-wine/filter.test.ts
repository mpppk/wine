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

	// 4フィルタ × 3状態 × 飲用件数 {0,1,2} の全36通りを固定する。
	// 「所有状態」と「飲んだことがあるか」は独立した2軸なので、組み合わせを
	// 網羅しないと「以前飲んで、また買った」(owned かつ tastingCount>0)の
	// ような交差ケースが落ちる。
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
		// owned / wishlist は所有状態だけを見る
		"owned/wishlist/0": false,
		"owned/wishlist/1": false,
		"owned/wishlist/2": false,
		"owned/owned/0": true,
		"owned/owned/1": true,
		"owned/owned/2": true,
		"owned/finished/0": false,
		"owned/finished/1": false,
		"owned/finished/2": false,
		"wishlist/wishlist/0": true,
		"wishlist/wishlist/1": true,
		"wishlist/wishlist/2": true,
		"wishlist/owned/0": false,
		"wishlist/owned/1": false,
		"wishlist/owned/2": false,
		"wishlist/finished/0": false,
		"wishlist/finished/1": false,
		"wishlist/finished/2": false,
	};

	it("全36通りの組み合わせが期待どおり", () => {
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
		});
	});

	it("1本が複数のチップに数えられる(排他ではない)", () => {
		const counts = countCellarFilters([
			{ status: "owned", tastingCount: 1 }, // tasted + owned
			{ status: "wishlist", tastingCount: 0 },
			{ status: "finished", tastingCount: 3 },
		]);
		expect(counts).toEqual({ all: 3, tasted: 2, owned: 1, wishlist: 1 });
	});
});
