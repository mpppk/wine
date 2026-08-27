import { describe, expect, it } from "vitest";
import { buildAgentLabelPrompt } from "./label-extraction";
import {
	assertGptLabelFinished,
	buildGptLabelMessages,
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

	it("エージェントループ用の指示文を使う（1リクエスト完結用の指示文ではない）", () => {
		// #524 の回帰防止: 本番経路が `buildAgentLabelPrompt` を使うことを固定する。
		// テストが `buildAgentLabelPrompt()` を直接呼んでいたため、本番から
		// 呼ばれていないことに気づけなかったのが原因。
		const messages = buildGptLabelMessages(["data:image/jpeg;base64,AAAA"]);
		const text = (messages[0] as { content: { type: string; text?: string }[] })
			.content[0]?.text;
		expect(text).toBeDefined();
		// エージェント固有の指示が含まれている
		expect(text).toContain("zoom_photo");
		expect(text).toContain("submit_answer");
		expect(text).toContain("search_appellation");
		expect(text).toContain("既知の品種リスト");
		// 1リクエスト完結用の指示は含まれていない
		expect(text).not.toContain("最後にJSONオブジェクトだけを出力してください");
		expect(text).not.toContain("既知の原産地呼称リスト");
	});

	it("指示文が buildAgentLabelPrompt と一致する", () => {
		const messages = buildGptLabelMessages(["data:image/jpeg;base64,AAAA"]);
		const text = (messages[0] as { content: { text?: string }[] }).content[0]
			?.text;
		expect(text).toBe(buildAgentLabelPrompt());
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
