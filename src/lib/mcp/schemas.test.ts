import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DRUNK_WINE_FIELD_DEFS } from "#/lib/drunk-wine/fields";
import { registerDrunkWineInput, updateDrunkWineInput } from "./schemas";

// schemas.ts の register/update 入力は DRUNK_WINE_FIELD_DEFS から生成される。
// ここでは「生成物が clear 規約どおりに振る舞うこと」を defs 駆動で検証する
// (フィールドを足すと自動的にカバーされる)。挙動は生成前の手書き版と不変。

const registerSchema = z.object(registerDrunkWineInput);
const updateSchema = z.object(updateDrunkWineInput);
const snakeKeys = DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey).sort();

describe("生成された MCP 入力スキーマのキー集合", () => {
	it("register = 9フィールド + photo2", () => {
		expect(Object.keys(registerDrunkWineInput).sort()).toEqual(
			[...snakeKeys, "photo_base64", "photo_mime_type"].sort(),
		);
	});

	it("update = id + 9フィールド + photo2", () => {
		expect(Object.keys(updateDrunkWineInput).sort()).toEqual(
			["id", ...snakeKeys, "photo_base64", "photo_mime_type"].sort(),
		);
	});
});

describe("updateDrunkWineInput の clear 規約", () => {
	for (const d of DRUNK_WINE_FIELD_DEFS) {
		if (d.clear === "null") {
			it(`${d.snakeKey}: null でクリアできる`, () => {
				const input: Record<string, unknown> = { id: "x" };
				input[d.snakeKey] = null;
				const parsed = updateSchema.parse(input) as Record<string, unknown>;
				expect(parsed[d.snakeKey]).toBeNull();
			});
		} else {
			it(`${d.snakeKey}: null は受け付けない (clear=${d.clear})`, () => {
				const input: Record<string, unknown> = { id: "x" };
				input[d.snakeKey] = null;
				expect(() => updateSchema.parse(input)).toThrow();
			});
		}
	}

	it("grape_variety_ids は [] でクリアできる", () => {
		const parsed = updateSchema.parse({ id: "x", grape_variety_ids: [] });
		expect(parsed.grape_variety_ids).toEqual([]);
	});

	it("id のみで部分更新できる(他フィールドは未指定=変更なし)", () => {
		const parsed = updateSchema.parse({ id: "x" });
		expect(parsed.id).toBe("x");
		expect("name" in parsed && parsed.name !== undefined).toBe(false);
	});
});

describe("registerDrunkWineInput", () => {
	it("name のみで有効", () => {
		const parsed = registerSchema.parse({ name: "Chablis" });
		expect(parsed.name).toBe("Chablis");
	});

	it("name 無しはエラー(必須)", () => {
		expect(() => registerSchema.parse({})).toThrow();
	});

	it("各フィールドの妥当値を受理する", () => {
		const parsed = registerSchema.parse({
			name: "テスト",
			drank_on: "2020-01-02",
			rating: 4,
			vintage: 2019,
			price: 3000,
			producer: "Domaine Test",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
			memo: "メモ",
		});
		expect(parsed.rating).toBe(4);
		expect(parsed.grape_variety_ids).toEqual(["chardonnay"]);
	});

	it("base バリデーションは維持される(rating 6 / vintage 1700 は不可)", () => {
		expect(() => registerSchema.parse({ name: "X", rating: 6 })).toThrow();
		expect(() => registerSchema.parse({ name: "X", vintage: 1700 })).toThrow();
	});
});
