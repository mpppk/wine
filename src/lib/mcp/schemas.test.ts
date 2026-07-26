import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	DRUNK_WINE_FIELD_DEFS,
	WINE_TASTING_FIELDS,
} from "#/lib/drunk-wine/fields";
import {
	addWineTastingInput,
	registerDrunkWineInput,
	updateDrunkWineInput,
} from "./schemas";

// schemas.ts の register/update 入力は DRUNK_WINE_FIELD_DEFS から生成される。
// ここでは「生成物が clear 規約どおりに振る舞うこと」を defs 駆動で検証する
// (フィールドを足すと自動的にカバーされる)。
//
// 飲んだ日・評価・メモは飲用記録(1:N)へ移ったが、MCP のツール引数としては
// 残している。外部クライアント(Claude 等)が従来の呼び方を続けられることが要件
// なので、引数の存在自体をここで回帰固定する。

const registerSchema = z.object(registerDrunkWineInput);
const updateSchema = z.object(updateDrunkWineInput);
const snakeKeys = DRUNK_WINE_FIELD_DEFS.map((d) => d.snakeKey);
const tastingKeys = WINE_TASTING_FIELDS.map((d) => d.snakeKey);

describe("生成された MCP 入力スキーマのキー集合", () => {
	it("register = 銘柄フィールド + 飲用記録の互換引数 + photo2", () => {
		expect(Object.keys(registerDrunkWineInput).sort()).toEqual(
			[...snakeKeys, ...tastingKeys, "photo_base64", "photo_mime_type"].sort(),
		);
	});

	it("update = id + 銘柄フィールド + 飲用記録の互換引数 + photo2", () => {
		expect(Object.keys(updateDrunkWineInput).sort()).toEqual(
			[
				"id",
				...snakeKeys,
				...tastingKeys,
				"photo_base64",
				"photo_mime_type",
			].sort(),
		);
	});

	it("add_wine_tasting = drunk_wine_id + 飲用記録フィールド", () => {
		expect(Object.keys(addWineTastingInput).sort()).toEqual(
			["drunk_wine_id", ...tastingKeys].sort(),
		);
	});
});

// 後方互換の回帰固定。ここが落ちたら既存の外部クライアントが壊れる。
describe("既存クライアントの呼び方", () => {
	it("register は drank_on / rating / memo を従来どおり受け取る", () => {
		const parsed = registerSchema.parse({
			name: "Chablis",
			drank_on: "2020-01-02",
			rating: 4,
			memo: "good",
		});
		expect(parsed.drank_on).toBe("2020-01-02");
		expect(parsed.rating).toBe(4);
		expect(parsed.memo).toBe("good");
	});

	it("update は drank_on / rating / memo を従来どおり受け取り null も許す", () => {
		const parsed = updateSchema.parse({
			id: "x",
			drank_on: null,
			rating: null,
			memo: null,
		});
		expect(parsed.drank_on).toBeNull();
		expect(parsed.rating).toBeNull();
		expect(parsed.memo).toBeNull();
	});

	it("飲用記録の引数にも base バリデーションが効く", () => {
		expect(() => registerSchema.parse({ name: "X", rating: 6 })).toThrow();
		expect(() =>
			registerSchema.parse({ name: "X", drank_on: "2026-02-31" }),
		).toThrow();
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
			status: "owned",
			drank_on: "2020-01-02",
			rating: 4,
			vintage: 2019,
			price: 3000,
			producer: "Domaine Test",
			aop_id: "chablis",
			grape_variety_ids: ["chardonnay"],
			memo: "メモ",
		});
		expect(parsed.status).toBe("owned");
		expect(parsed.grape_variety_ids).toEqual(["chardonnay"]);
	});

	it("status は enum 外の値を拒否する", () => {
		expect(() =>
			registerSchema.parse({ name: "X", status: "drunk" }),
		).toThrow();
	});

	it("base バリデーションは維持される(vintage 1700 は不可)", () => {
		expect(() => registerSchema.parse({ name: "X", vintage: 1700 })).toThrow();
	});
});
