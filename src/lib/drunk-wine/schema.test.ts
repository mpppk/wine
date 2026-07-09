import { describe, expect, it } from "vitest";
import { createDrunkWineInput, updateDrunkWineInput } from "./schema";

describe("createDrunkWineInput", () => {
	it("名前だけで登録できる(他は任意)", () => {
		const parsed = createDrunkWineInput.parse({ name: "Chablis" });
		expect(parsed.name).toBe("Chablis");
		expect(parsed.aopId).toBeUndefined();
	});

	it("名前は必須で空文字は拒否する", () => {
		expect(() => createDrunkWineInput.parse({ name: "  " })).toThrow();
		expect(() => createDrunkWineInput.parse({})).toThrow();
	});

	it("全フィールドを受け付ける", () => {
		const parsed = createDrunkWineInput.parse({
			name: "Morgon Côte du Py",
			drankOn: "2026-07-01",
			aopId: "morgon",
			rating: 4,
			memo: "ガメイらしい果実味",
			vintage: 2022,
			grapeVarietyIds: ["gamay"],
			producer: "Jean Foillard",
			price: 4500,
		});
		expect(parsed.rating).toBe(4);
		expect(parsed.grapeVarietyIds).toEqual(["gamay"]);
	});

	it("ratingは1-5の整数のみ", () => {
		expect(() =>
			createDrunkWineInput.parse({ name: "x", rating: 0 }),
		).toThrow();
		expect(() =>
			createDrunkWineInput.parse({ name: "x", rating: 6 }),
		).toThrow();
		expect(() =>
			createDrunkWineInput.parse({ name: "x", rating: 3.5 }),
		).toThrow();
	});

	it("drankOnはYYYY-MM-DD形式のみ", () => {
		expect(() =>
			createDrunkWineInput.parse({ name: "x", drankOn: "2026/07/01" }),
		).toThrow();
		expect(() =>
			createDrunkWineInput.parse({ name: "x", drankOn: "July 1" }),
		).toThrow();
	});

	it("負の価格・範囲外ヴィンテージを拒否する", () => {
		expect(() =>
			createDrunkWineInput.parse({ name: "x", price: -1 }),
		).toThrow();
		expect(() =>
			createDrunkWineInput.parse({ name: "x", vintage: 1700 }),
		).toThrow();
	});
});

describe("updateDrunkWineInput", () => {
	it("idのみで有効(部分更新)", () => {
		const parsed = updateDrunkWineInput.parse({ id: "abc" });
		expect(parsed.id).toBe("abc");
		expect("name" in parsed && parsed.name !== undefined).toBe(false);
	});

	it("nullでフィールドをクリアできる", () => {
		const parsed = updateDrunkWineInput.parse({
			id: "abc",
			rating: null,
			aopId: null,
		});
		expect(parsed.rating).toBeNull();
		expect(parsed.aopId).toBeNull();
	});

	it("nameはnullにできない(必須フィールド)", () => {
		expect(() =>
			updateDrunkWineInput.parse({ id: "abc", name: null }),
		).toThrow();
	});
});
