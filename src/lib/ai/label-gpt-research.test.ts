import { describe, expect, it } from "vitest";
import { LABEL_WEB_JSON_SCHEMA } from "./label-extraction";
import {
	assertGptLabelFinished,
	buildGptLabelMessages,
	buildGptLabelOutput,
	GPT_LABEL_OUTPUT_SCHEMA,
	GPT_LABEL_SCHEMA_NAME,
	GPT_WEB_SEARCH_TOOL_NAME,
} from "./label-gpt-research";

describe("buildGptLabelMessages", () => {
	it("指示文と全画像を1つのuserメッセージに載せる", () => {
		const messages = buildGptLabelMessages([
			"data:image/jpeg;base64,AAAA",
			"data:image/png;base64,BBBB",
		]);
		expect(messages).toHaveLength(1);
		const message = messages[0] as { role: string; content: unknown[] };
		expect(message.role).toBe("user");
		expect(message.content).toHaveLength(3);
		expect(message.content[0]).toMatchObject({ type: "text" });
		expect(message.content[1]).toEqual({
			type: "file",
			mediaType: "image/jpeg",
			data: "data:image/jpeg;base64,AAAA",
		});
		expect(message.content[2]).toEqual({
			type: "file",
			mediaType: "image/png",
			data: "data:image/png;base64,BBBB",
		});
	});

	it("画像は file パートで渡す(image パートはプロンプトキャッシュを外す)", () => {
		// 非推奨の image パートで渡すとシリアライズが変わり、キャッシュのプレフィクスが
		// 一致しなくなる。実測でコストが約2倍になった(#455)。
		const message = buildGptLabelMessages([
			"data:image/jpeg;base64,AAAA",
		])[0] as {
			content: { type: string }[];
		};
		expect(message.content.map((c) => c.type)).toEqual(["text", "file"]);
	});

	it("data URI 以外(HTTP URL)は弾く", () => {
		// 素の URL も受け付けてしまうため、境界で data URI を強制する
		expect(() =>
			buildGptLabelMessages(["https://example.com/a.jpg"]),
		).toThrow();
		expect(() =>
			buildGptLabelMessages(["data:image/jpeg,notbase64"]),
		).toThrow();
	});
});

describe("buildGptLabelOutput", () => {
	it("高精度経路の出力スキーマ(根拠つき)を structured outputs に渡す", () => {
		// 出力フィールドの SSOT は LABEL_WEB_JSON_SCHEMA(経路ごとに書き分けない)。
		// 本体フィールドは LABEL_JSON_SCHEMA から derive されている。
		expect(GPT_LABEL_OUTPUT_SCHEMA.jsonSchema).toBe(LABEL_WEB_JSON_SCHEMA);
	});

	it("Output として組み立てられる", () => {
		expect(buildGptLabelOutput()).toBeDefined();
	});

	it("スキーマ名は structured outputs の命名制約(a-zA-Z0-9_-, 64文字以内)を満たす", () => {
		expect(GPT_LABEL_SCHEMA_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
	});
});

describe("assertGptLabelFinished", () => {
	it("正常終了は通す", () => {
		expect(() => assertGptLabelFinished("stop")).not.toThrow();
	});

	it("ツール呼び出しで終わった応答も通す(web検索はプロバイダ実行ツール)", () => {
		expect(() => assertGptLabelFinished("tool-calls")).not.toThrow();
	});

	it("出力上限での打ち切りは理由つきでthrowする", () => {
		// 素通しすると「JSONの形式が不正」という無関係な例外になり、web検索/reasoning が
		// 出力枠を食い切ったことが後から追えなくなる
		expect(() => assertGptLabelFinished("length")).toThrow("length");
	});

	it("セーフティ拒否はthrowする(structured outputsでもスキーマに従わない)", () => {
		expect(() => assertGptLabelFinished("content-filter")).toThrow(
			"content-filter",
		);
	});

	it("プロバイダ側エラーはthrowする", () => {
		expect(() => assertGptLabelFinished("error")).toThrow("error");
	});

	it("未知の finishReason は通す(新しい値で機能を止めない)", () => {
		expect(() => assertGptLabelFinished("other")).not.toThrow();
	});
});

describe("GPT_WEB_SEARCH_TOOL_NAME", () => {
	it("計上と軌跡の抽出が同じツール名を見る", () => {
		// 回数課金の計上(countProviderExecutedCalls)がこの名前でツール呼び出しを
		// 数えるので、リクエスト側の tools のキーと食い違うと原価が丸ごと漏れる。
		expect(GPT_WEB_SEARCH_TOOL_NAME).toBe("web_search");
	});
});
