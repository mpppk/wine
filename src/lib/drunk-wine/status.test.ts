import { describe, expect, it } from "vitest";
import {
	buildAopStatusMap,
	DEFAULT_WINE_STATUS,
	hasMixedAopStatus,
	isTasted,
	pickAopStatus,
	WINE_STATUS_IDS,
	WINE_STATUS_LABELS_JA,
	WINE_STATUSES,
	type WineStatus,
} from "./status";

describe("WINE_STATUSES", () => {
	it("id 集合は wishlist / owned / finished / spotted の4値", () => {
		expect([...WINE_STATUS_IDS].sort()).toEqual([
			"finished",
			"owned",
			"spotted",
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

	it("owned > wishlist > finished > spotted の優先度で1つに畳む", () => {
		expect(pickAopStatus(["finished", "owned"])).toBe("owned");
		expect(pickAopStatus(["finished", "wishlist"])).toBe("wishlist");
		expect(pickAopStatus(["wishlist", "owned"])).toBe("owned");
		expect(pickAopStatus(["finished", "wishlist", "owned"])).toBe("owned");
	});

	it("spotted は最下位(見かけただけは飲んだ実績より弱い関係)", () => {
		expect(pickAopStatus(["spotted", "finished"])).toBe("finished");
		expect(pickAopStatus(["spotted", "wishlist"])).toBe("wishlist");
		expect(pickAopStatus(["spotted", "owned"])).toBe("owned");
		// spotted しか無ければ spotted のまま
		expect(pickAopStatus(["spotted"])).toBe("spotted");
	});

	it("順序に依存しない", () => {
		const all: WineStatus[] = ["finished", "wishlist", "owned", "spotted"];
		expect(pickAopStatus(all)).toBe(pickAopStatus([...all].reverse()));
	});
});

describe("buildAopStatusMap", () => {
	it("AOPごとに優先度どおり1状態へ畳む", () => {
		const m = buildAopStatusMap([
			{ aopId: "chablis", status: "finished" },
			{ aopId: "chablis", status: "owned" },
			{ aopId: "meursault", status: "finished" },
			{ aopId: "pomerol", status: "wishlist" },
			{ aopId: "pomerol", status: "finished" },
		]);
		// 「今すぐ飲める1本がある」が最優先
		expect(m.get("chablis")).toBe("owned");
		expect(m.get("meursault")).toBe("finished");
		expect(m.get("pomerol")).toBe("wishlist");
	});

	it("AOP未紐付けのエントリは地図に出せないので落とす", () => {
		const m = buildAopStatusMap([
			{ aopId: null, status: "owned" },
			{ aopId: "chablis", status: "finished" },
		]);
		expect(m.size).toBe(1);
		expect(m.has("chablis")).toBe(true);
	});

	it("入力順に依存しない", () => {
		const entries = [
			{ aopId: "chablis", status: "finished" as WineStatus },
			{ aopId: "chablis", status: "owned" as WineStatus },
			{ aopId: "chablis", status: "wishlist" as WineStatus },
		];
		expect(buildAopStatusMap(entries).get("chablis")).toBe(
			buildAopStatusMap([...entries].reverse()).get("chablis"),
		);
	});

	it("空入力なら空のMap", () => {
		expect(buildAopStatusMap([]).size).toBe(0);
	});
});

describe("hasMixedAopStatus", () => {
	it("同じAOPに違う状態があれば true", () => {
		expect(
			hasMixedAopStatus([
				{ aopId: "chablis", status: "owned" },
				{ aopId: "chablis", status: "finished" },
			]),
		).toBe(true);
	});

	it("AOPごとに状態が1つなら false(別AOPで状態が違っても混在ではない)", () => {
		expect(
			hasMixedAopStatus([
				{ aopId: "chablis", status: "owned" },
				{ aopId: "beaune", status: "finished" },
				{ aopId: "chablis", status: "owned" },
			]),
		).toBe(false);
	});

	it("AOP未紐付けは無視する", () => {
		expect(
			hasMixedAopStatus([
				{ aopId: null, status: "owned" },
				{ aopId: null, status: "finished" },
			]),
		).toBe(false);
	});

	it("空入力なら false", () => {
		expect(hasMixedAopStatus([])).toBe(false);
	});
});

describe("isTasted", () => {
	it("飲用記録の件数だけで決まる(所有状態に依存しない)", () => {
		expect(isTasted({ tastingCount: 0 })).toBe(false);
		expect(isTasted({ tastingCount: 1 })).toBe(true);
		expect(isTasted({ tastingCount: 3 })).toBe(true);
	});
});
