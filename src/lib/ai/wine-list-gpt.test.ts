import { describe, expect, it } from "vitest";
import { BadRequestError } from "#/lib/errors";
import { WINE_LIST_TRUNCATED_ERROR_MESSAGE } from "./wine-list-extraction";
import {
	assertWineListChatFinished,
	buildWineListGptInput,
	buildWineListGptTextFormat,
	WINE_LIST_JSON_SCHEMA,
} from "./wine-list-gpt";

// 一括抽出の GPT 経路は**OpenRouter の chat completions で呼ぶ**(#602 で Responses API
// 直接接続から移行)。終了理由の判定は OpenRouter が正規化した finish_reason で行い、
// web検索の回数は応答の usage(`toOpenRouterUsage`)から取る。

describe("assertWineListChatFinished", () => {
	it("length は銘柄数超過として BadRequest(写真を分ける案内)にする", () => {
		expect(() => assertWineListChatFinished("length", '{"wines":[')).toThrow(
			BadRequestError,
		);
		expect(() => assertWineListChatFinished("length", '{"wines":[')).toThrow(
			WINE_LIST_TRUNCATED_ERROR_MESSAGE,
		);
	});

	it("content_filter/error は素の Error(利用者が行動できない)", () => {
		expect(() => assertWineListChatFinished("content_filter", "")).toThrow(
			"拒否",
		);
		expect(() => assertWineListChatFinished("error", "")).toThrow(Error);
	});

	it("空の本文は失敗として扱う(空の成功を作らない)", () => {
		expect(() => assertWineListChatFinished("stop", "  ")).toThrow();
	});

	it("正常な完結は通す", () => {
		expect(() =>
			assertWineListChatFinished("stop", '{"wines":[]}'),
		).not.toThrow();
		expect(() =>
			assertWineListChatFinished("tool_calls", '{"wines":[]}'),
		).not.toThrow();
	});
});

describe("buildWineListGptInput", () => {
	it("指示文と写真番号付きの画像を載せる", () => {
		const messages = buildWineListGptInput([
			"data:image/jpeg;base64,AAAA",
			"data:image/png;base64,BBBB",
		]);
		expect(messages).toHaveLength(1);
		const content = messages[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		if (!Array.isArray(content)) throw new Error("unreachable");
		expect(content[0]).toMatchObject({ type: "text" });
		expect(content[1]).toEqual({ type: "text", text: "写真 0" });
		expect(content[2]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,AAAA" },
		});
		expect(content[3]).toEqual({ type: "text", text: "写真 1" });
		expect(content[4]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/png;base64,BBBB" },
		});
	});

	it("HTTP URLは境界で拒否する", () => {
		expect(() =>
			buildWineListGptInput(["https://example.com/photo.jpg"]),
		).toThrow();
	});
});

describe("buildWineListGptTextFormat", () => {
	it("response_format の json_schema でスキーマを渡す(strict ではない)", () => {
		// スキーマが合併型(type: ["integer", "null"])を含むため strict の条件を
		// 満たさない。strict にするとリクエストごと 400 になる。
		const format = buildWineListGptTextFormat();
		expect(format.type).toBe("json_schema");
		expect(format.json_schema.name).toBe("wine_list_extraction");
		expect(format.json_schema.strict).toBe(false);
		expect(format.json_schema.schema).toBe(WINE_LIST_JSON_SCHEMA);
	});
});

describe("WINE_LIST_JSON_SCHEMA", () => {
	it("出力の骨格(銘柄配列・被写体・打ち切り)を定義する", () => {
		expect(WINE_LIST_JSON_SCHEMA.additionalProperties).toBe(false);
		expect([...WINE_LIST_JSON_SCHEMA.required].sort()).toEqual(
			Object.keys(WINE_LIST_JSON_SCHEMA.properties).sort(),
		);
	});

	it("銘柄ごとのコメント(#493)と写真の手当て(#473)を載せる", () => {
		const item = WINE_LIST_JSON_SCHEMA.properties.wines.items;
		for (const key of [
			"tasting_comment",
			"producer_comment",
			"bottle_photo_index",
			"image_url",
			"image_note",
		]) {
			expect(item.properties).toHaveProperty(key);
			expect(item.required).toContain(key);
		}
	});

	it("参考サイト・価格(IMPL-3)を載せる(エチケット解析と同一定義)", () => {
		const item = WINE_LIST_JSON_SCHEMA.properties.wines.items;
		for (const key of ["reference_links", "prices"]) {
			expect(item.properties).toHaveProperty(key);
			expect(item.required).toContain(key);
		}
	});
});
