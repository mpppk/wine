import { describe, expect, it } from "vitest";
import {
	BULK_DELETE_MAX,
	createDrunkWineInput,
	createWineTastingInput,
	deleteDrunkWinesInput,
	updateDrunkWineInput,
	updateWineTastingInput,
} from "./schema";

describe("createDrunkWineInput", () => {
	it("名前だけで登録できる(他は任意)", () => {
		const parsed = createDrunkWineInput.parse({ name: "Chablis" });
		expect(parsed.name).toBe("Chablis");
		expect(parsed.aopId).toBeUndefined();
		// status 未指定はサービス層が DEFAULT_WINE_STATUS で埋める
		expect(parsed.status).toBeUndefined();
	});

	it("名前は必須で空文字は拒否する", () => {
		expect(() => createDrunkWineInput.parse({ name: "  " })).toThrow();
		expect(() => createDrunkWineInput.parse({})).toThrow();
	});

	it("全フィールドを受け付ける", () => {
		const parsed = createDrunkWineInput.parse({
			name: "Morgon Côte du Py",
			status: "owned",
			aopId: "morgon",
			vintage: 2022,
			grapeVarietyIds: ["gamay"],
			producer: "Jean Foillard",
			price: 4500,
			tasting: { drankOn: "2026-07-01", rating: 4, memo: "ガメイらしい果実味" },
		});
		expect(parsed.status).toBe("owned");
		expect(parsed.grapeVarietyIds).toEqual(["gamay"]);
		expect(parsed.tasting?.rating).toBe(4);
	});

	it("statusは既定の3値のみ", () => {
		expect(
			createDrunkWineInput.parse({ name: "x", status: "wishlist" }).status,
		).toBe("wishlist");
		expect(() =>
			createDrunkWineInput.parse({ name: "x", status: "drunk" }),
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

describe("createWineTastingInput", () => {
	it("全項目が任意(日付不明の記録を作れる)", () => {
		expect(createWineTastingInput.parse({})).toEqual({});
	});

	it("ratingは1-5の整数のみ", () => {
		expect(() => createWineTastingInput.parse({ rating: 0 })).toThrow();
		expect(() => createWineTastingInput.parse({ rating: 6 })).toThrow();
		expect(() => createWineTastingInput.parse({ rating: 3.5 })).toThrow();
	});

	it("drankOnはYYYY-MM-DD形式のみ", () => {
		expect(() =>
			createWineTastingInput.parse({ drankOn: "2026/07/01" }),
		).toThrow();
		expect(() => createWineTastingInput.parse({ drankOn: "July 1" })).toThrow();
	});

	it("暦として存在しない日付を拒否する", () => {
		expect(() =>
			createWineTastingInput.parse({ drankOn: "2026-02-31" }),
		).toThrow();
		expect(() =>
			createWineTastingInput.parse({ drankOn: "2026-13-01" }),
		).toThrow();
		// うるう年はOK
		expect(
			createWineTastingInput.parse({ drankOn: "2024-02-29" }).drankOn,
		).toBe("2024-02-29");
	});

	it("drankOnの年は1900-2100に制限(0-99年のDate.UTC罠も回避)", () => {
		expect(() =>
			createWineTastingInput.parse({ drankOn: "0099-12-31" }),
		).toThrow();
		expect(() =>
			createWineTastingInput.parse({ drankOn: "1899-12-31" }),
		).toThrow();
		expect(
			createWineTastingInput.parse({ drankOn: "1900-01-01" }).drankOn,
		).toBe("1900-01-01");
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
			price: null,
			aopId: null,
		});
		expect(parsed.price).toBeNull();
		expect(parsed.aopId).toBeNull();
	});

	it("nameはnullにできない(必須フィールド)", () => {
		expect(() =>
			updateDrunkWineInput.parse({ id: "abc", name: null }),
		).toThrow();
	});

	it("statusはnullにできない(NOT NULL列)", () => {
		expect(() =>
			updateDrunkWineInput.parse({ id: "abc", status: null }),
		).toThrow();
	});
});

describe("updateWineTastingInput", () => {
	it("nullで各列をクリアできる(記録の行は消さない)", () => {
		const parsed = updateWineTastingInput.parse({
			id: "t1",
			drankOn: null,
			rating: null,
			memo: null,
		});
		expect(parsed.drankOn).toBeNull();
		expect(parsed.rating).toBeNull();
		expect(parsed.memo).toBeNull();
	});
});

describe("deleteDrunkWinesInput", () => {
	const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

	// #400: 上限を一覧のページサイズ(100)に合わせていた頃は、120件を「すべて選択」
	// した削除が zod で拒否され、生の検証メッセージが画面に出ていた。
	it("ページサイズを超える選択(101件・120件)も受け付ける", () => {
		expect(deleteDrunkWinesInput.parse({ ids: ids(101) }).ids).toHaveLength(
			101,
		);
		expect(deleteDrunkWinesInput.parse({ ids: ids(120) }).ids).toHaveLength(
			120,
		);
	});

	it("1リクエストの上限ちょうどは通り、超えると拒否する(分割は呼び出し側の責務)", () => {
		expect(
			deleteDrunkWinesInput.parse({ ids: ids(BULK_DELETE_MAX) }).ids,
		).toHaveLength(BULK_DELETE_MAX);
		expect(() =>
			deleteDrunkWinesInput.parse({ ids: ids(BULK_DELETE_MAX + 1) }),
		).toThrow();
	});

	it("空配列は拒否する(削除対象が無い呼び出しは呼び出し側のミス)", () => {
		expect(() => deleteDrunkWinesInput.parse({ ids: [] })).toThrow();
	});
});
