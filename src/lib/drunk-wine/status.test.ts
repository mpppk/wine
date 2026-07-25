import { describe, expect, it } from "vitest";
import {
	DEFAULT_WINE_STATUS,
	isTasted,
	pickAopStatus,
	WINE_STATUS_IDS,
	WINE_STATUS_LABELS_JA,
	WINE_STATUSES,
	type WineStatus,
} from "./status";

describe("WINE_STATUSES", () => {
	it("id 集合は wishlist / owned / finished の3値", () => {
		expect([...WINE_STATUS_IDS].sort()).toEqual([
			"finished",
			"owned",
			"wishlist",
		]);
	});

	it("既定値はマイグレーションの DEFAULT と同じ finished", () => {
		expect(DEFAULT_WINE_STATUS).toBe("finished");
	});

	it("全 status に日本語ラベルと説明がある", () => {
		for (const s of WINE_STATUSES) {
			expect(WINE_STATUS_LABELS_JA[s.id]).toBeTruthy();
			expect(s.descriptionJa).toBeTruthy();
		}
	});
});

describe("pickAopStatus", () => {
	it("エントリが無ければ null", () => {
		expect(pickAopStatus([])).toBeNull();
	});

	it("単一ならそのまま", () => {
		for (const id of WINE_STATUS_IDS) {
			expect(pickAopStatus([id])).toBe(id);
		}
	});

	it("owned > wishlist > finished の優先度で1つに畳む", () => {
		expect(pickAopStatus(["finished", "owned"])).toBe("owned");
		expect(pickAopStatus(["finished", "wishlist"])).toBe("wishlist");
		expect(pickAopStatus(["wishlist", "owned"])).toBe("owned");
		expect(pickAopStatus(["finished", "wishlist", "owned"])).toBe("owned");
	});

	it("順序に依存しない", () => {
		const all: WineStatus[] = ["finished", "wishlist", "owned"];
		expect(pickAopStatus(all)).toBe(pickAopStatus([...all].reverse()));
	});
});

describe("isTasted", () => {
	it("飲用記録の件数だけで決まる(所有状態に依存しない)", () => {
		expect(isTasted({ tastingCount: 0 })).toBe(false);
		expect(isTasted({ tastingCount: 1 })).toBe(true);
		expect(isTasted({ tastingCount: 3 })).toBe(true);
	});
});
