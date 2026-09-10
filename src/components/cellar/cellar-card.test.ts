import { describe, expect, it } from "vitest";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { buildCellarCardLines } from "./cellar-card";

// マイセラー一覧(/cellar)のカード補助行の規約(Issue #597):
//  - 生産者は重要な情報なので出す
//  - 代わりにヴィンテージは出さない
//  - 値が無い項目は行ごと落とす

const BASE: DrunkWineEntry = {
	id: "e1",
	name: "テストワイン",
	status: "finished",
	lastDrankOn: null,
	tastingCount: 0,
	lastSeenOn: null,
	sightingCount: 0,
	aopId: null,
	aopNameJa: null,
	regionId: null,
	countryId: null,
	lastRating: null,
	lastMemo: null,
	vintage: null,
	grapeVarietyIds: [],
	producer: null,
	note: null,
	price: null,
	referenceLinks: [],
	prices: [],
	photoUrls: [],
	thumbUrls: [],
	photoKinds: [],
	createdAt: 0,
	updatedAt: 0,
};

describe("buildCellarCardLines", () => {
	it("値が無いときは空行を出さない", () => {
		expect(buildCellarCardLines(BASE)).toEqual([]);
	});

	it("生産者を出し、ヴィンテージは出さない", () => {
		const lines = buildCellarCardLines({
			...BASE,
			vintage: 2020,
			producer: "ドメーヌ・ルフレーヴ",
		});
		expect(lines).toContain("ドメーヌ・ルフレーヴ");
		expect(lines.some((line) => line.includes("2020"))).toBe(false);
	});

	it("生産者が無いときは生産者行を作らない", () => {
		expect(buildCellarCardLines({ ...BASE, vintage: 2020 })).toEqual([]);
	});

	it("飲用日・回数・産地・生産者の順に並べる", () => {
		const lines = buildCellarCardLines({
			...BASE,
			lastDrankOn: "2026-09-01",
			tastingCount: 3,
			regionId: "bourgogne",
			producer: "ドメーヌ・ルフレーヴ",
		});
		expect(lines).toEqual([
			"2026-09-01",
			"3回飲んだ",
			"ブルゴーニュ",
			"ドメーヌ・ルフレーヴ",
		]);
	});

	it("飲用が1回だけなら回数行を作らない", () => {
		const lines = buildCellarCardLines({ ...BASE, tastingCount: 1 });
		expect(lines).toEqual([]);
	});
});
