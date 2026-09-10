import { describe, expect, it } from "vitest";
import { buildCellarCardLines } from "./cellar-card";
import { makeDrunkWineEntry } from "./drunk-wine-entry-fixture";

// マイセラー一覧(/cellar)のカード補助行の規約(Issue #597):
//  - 生産者は重要な情報なので出す
//  - 代わりにヴィンテージは出さない
//  - 値が無い項目は行ごと落とす
describe("buildCellarCardLines", () => {
	it("値が無いときは空行を出さない", () => {
		expect(buildCellarCardLines(makeDrunkWineEntry())).toEqual([]);
	});

	it("生産者を出し、ヴィンテージは出さない", () => {
		const lines = buildCellarCardLines(
			makeDrunkWineEntry({ vintage: 2020, producer: "ドメーヌ・ルフレーヴ" }),
		);
		expect(lines).toContain("ドメーヌ・ルフレーヴ");
		expect(lines.some((line) => line.includes("2020"))).toBe(false);
	});

	it("生産者が無いときは生産者行を作らない", () => {
		expect(buildCellarCardLines(makeDrunkWineEntry({ vintage: 2020 }))).toEqual(
			[],
		);
	});

	it("飲用日・回数・産地・生産者の順に並べる", () => {
		const lines = buildCellarCardLines(
			makeDrunkWineEntry({
				lastDrankOn: "2026-09-01",
				tastingCount: 3,
				regionId: "bourgogne",
				producer: "ドメーヌ・ルフレーヴ",
			}),
		);
		expect(lines).toEqual([
			"2026-09-01",
			"3回飲んだ",
			"ブルゴーニュ",
			"ドメーヌ・ルフレーヴ",
		]);
	});

	it("飲用が1回だけなら回数行を作らない", () => {
		const lines = buildCellarCardLines(makeDrunkWineEntry({ tastingCount: 1 }));
		expect(lines).toEqual([]);
	});
});
