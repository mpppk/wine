import { describe, expect, it, vi } from "vitest";
import {
	chatCompletion,
	OPENROUTER_API_URL,
	OpenRouterError,
	toOpenRouterUsage,
} from "./openrouter";

describe("toOpenRouterUsage", () => {
	it("入力・出力・キャッシュ読み・web検索回数を分けて返す", () => {
		expect(
			toOpenRouterUsage({
				prompt_tokens: 10_000,
				completion_tokens: 2_000,
				prompt_tokens_details: { cached_tokens: 6_000 },
				server_tool_use: { web_search_requests: 3 },
			}),
		).toEqual({
			inputTokens: 4_000,
			outputTokens: 2_000,
			cacheReadTokens: 6_000,
			webSearches: 3,
		});
	});

	it("reasoning_tokensは二重加算しない(completionの内数として扱う)", () => {
		expect(
			toOpenRouterUsage({
				prompt_tokens: 100,
				completion_tokens: 500,
				completion_tokens_details: { reasoning_tokens: 400 },
			}),
		).toEqual({
			inputTokens: 100,
			outputTokens: 500,
			cacheReadTokens: 0,
			webSearches: 0,
		});
	});

	it("形が崩れていても0扱いで続行する(throwしない)", () => {
		expect(toOpenRouterUsage(undefined)).toEqual({});
		expect(toOpenRouterUsage(null)).toEqual({});
		expect(toOpenRouterUsage({ prompt_tokens: -5 })).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			webSearches: 0,
		});
	});
});

describe("chatCompletion", () => {
	it("空キーは投げずにauthエラーにする", async () => {
		await expect(
			chatCompletion("  ", { model: "m", messages: [] }),
		).rejects.toMatchObject({ name: "OpenRouterError", code: "auth" });
	});

	it("401/402/429/5xxを分類し、他プロバイダへのフォールバックはしない(throwする)", async () => {
		const cases: Array<[number, string, number]> = [
			[401, "auth", 500],
			[402, "insufficient_credits", 500],
			[429, "rate_limited", 429],
			[500, "provider_error", 502],
		];
		for (const [status, code, httpStatus] of cases) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({ error: { message: "boom" } }, { status }),
				),
			);
			const err = await chatCompletion("k", {
				model: "m",
				messages: [],
			}).catch((e) => e);
			expect(err).toBeInstanceOf(OpenRouterError);
			expect(err.code).toBe(code);
			expect(err.status).toBe(httpStatus);
			vi.unstubAllGlobals();
		}
	});

	it("応答を共通形へ畳む(本文・ツール呼び出し・usage・アノテーション)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				expect(url).toBe(OPENROUTER_API_URL);
				const headers = new Headers(init.headers);
				expect(headers.get("Authorization")).toBe("Bearer k");
				expect(headers.get("HTTP-Referer")).toBeTruthy();
				const body = JSON.parse(init.body as string);
				expect(body.model).toBe("openai/gpt-5.6-luna");
				expect(body.provider).toEqual({ allow_fallbacks: true });
				expect(body.tools).toEqual([
					{ type: "openrouter:web_search", parameters: { engine: "native" } },
				]);
				return Response.json({
					choices: [
						{
							finish_reason: "tool_calls",
							native_finish_reason: "tool_calls",
							message: {
								content: "hello",
								tool_calls: [
									{
										id: "c1",
										function: {
											name: "submit_answer",
											arguments: '{"a":1}',
										},
									},
								],
								annotations: [
									{
										type: "url_citation",
										url_citation: { url: "https://example.com/x" },
									},
								],
							},
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 10,
						server_tool_use: { web_search_requests: 2 },
					},
				});
			}),
		);
		try {
			const result = await chatCompletion("k", {
				model: "openai/gpt-5.6-luna",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{ type: "openrouter:web_search", parameters: { engine: "native" } },
				],
			});
			expect(result.text).toBe("hello");
			expect(result.toolCalls).toEqual([
				{ id: "c1", name: "submit_answer", arguments: '{"a":1}' },
			]);
			expect(result.usage).toEqual({
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 0,
				webSearches: 2,
			});
			expect(result.annotations).toHaveLength(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
