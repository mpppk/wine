import { describe, expect, it } from "vitest";
import {
	extractAnthropicTrace,
	extractGptTrace,
	WEB_RESEARCH_MAX_STEPS,
	WEB_RESEARCH_MAX_URLS_PER_STEP,
} from "./web-research-trace";

// 高精度エチケット解析の裏取りを観測するための軌跡抽出。**プロバイダごとに全く違う
// 応答の形を同じ型へ落とす**のがこのモジュールの仕事なので、両プロバイダで同じ
// 期待値が出ることをテストで固定する(ログの読み手が経路ごとに別のフィールドを
// 覚えなくて済む、が要件)。

describe("extractAnthropicTrace", () => {
	it("server_tool_use と web_search_tool_result を tool_use_id で対応づける", () => {
		const trace = extractAnthropicTrace([
			{ type: "text", text: "調べます" },
			{
				type: "server_tool_use",
				id: "srvtoolu_1",
				name: "web_search",
				input: { query: "Domaine Leflaive Chablis 2020" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_1",
				content: [
					{
						type: "web_search_result",
						url: "https://leflaive.fr/vins",
						title: "Vins",
					},
					{
						type: "web_search_result",
						url: "https://www.wine-searcher.com/find/leflaive",
						title: "Wine-Searcher",
					},
				],
			},
		]);
		expect(trace.steps).toEqual([
			{
				action: "search",
				query: "Domaine Leflaive Chablis 2020",
				urls: [
					"https://leflaive.fr/vins",
					"https://www.wine-searcher.com/find/leflaive",
				],
				urlCount: 2,
			},
		]);
		expect(trace.stepCount).toBe(1);
		expect(trace.hosts).toEqual(["leflaive.fr", "www.wine-searcher.com"]);
	});

	it("ブロックの並び順ではなく id で紐づける(継続をまたいで連結されるため)", () => {
		// pause_turn の継続では複数レスポンスの content を連結して渡すので、
		// 「直近の未解決な server_tool_use」に寄せると取り違える
		const trace = extractAnthropicTrace([
			{
				type: "server_tool_use",
				id: "a",
				name: "web_search",
				input: { query: "q1" },
			},
			{
				type: "server_tool_use",
				id: "b",
				name: "web_search",
				input: { query: "q2" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "b",
				content: [{ url: "https://example.com/b" }],
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "a",
				content: [{ url: "https://example.com/a" }],
			},
		]);
		expect(trace.steps.map((s) => [s.query, s.urls?.[0]])).toEqual([
			["q1", "https://example.com/a"],
			["q2", "https://example.com/b"],
		]);
	});

	it("検索が失敗したときは error_code を残す(上限で裏取りを諦めたことが分かる)", () => {
		const trace = extractAnthropicTrace([
			{
				type: "server_tool_use",
				id: "x",
				name: "web_search",
				input: { query: "q" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "x",
				content: {
					type: "web_search_tool_result_error",
					error_code: "max_uses_exceeded",
				},
			},
		]);
		expect(trace.steps[0]).toMatchObject({
			query: "q",
			error: "max_uses_exceeded",
		});
	});

	it("web検索以外のブロック(thinking / tool_use)は無視する", () => {
		const trace = extractAnthropicTrace([
			{ type: "thinking", thinking: "..." },
			{ type: "server_tool_use", id: "z", name: "code_execution", input: {} },
			{ type: "text", text: "{}" },
		]);
		expect(trace).toEqual({ steps: [], stepCount: 0, hosts: [] });
	});

	it("URLは1操作あたり上限まで載せ、総数は urlCount に残す", () => {
		const urls = Array.from({ length: 12 }, (_, i) => ({
			url: `https://example.com/${i}`,
		}));
		const trace = extractAnthropicTrace([
			{
				type: "server_tool_use",
				id: "x",
				name: "web_search",
				input: { query: "q" },
			},
			{ type: "web_search_tool_result", tool_use_id: "x", content: urls },
		]);
		expect(trace.steps[0]?.urls).toHaveLength(WEB_RESEARCH_MAX_URLS_PER_STEP);
		expect(trace.steps[0]?.urlCount).toBe(12);
	});

	it("操作数は上限で打ち切り、総数は stepCount に残す", () => {
		const blocks = Array.from(
			{ length: WEB_RESEARCH_MAX_STEPS + 5 },
			(_, i) => ({
				type: "server_tool_use",
				id: `s${i}`,
				name: "web_search",
				input: { query: `q${i}` },
			}),
		);
		const trace = extractAnthropicTrace(blocks);
		expect(trace.steps).toHaveLength(WEB_RESEARCH_MAX_STEPS);
		expect(trace.stepCount).toBe(WEB_RESEARCH_MAX_STEPS + 5);
	});

	it("応答が空でも throw せず空の軌跡を返す(観測が解析を壊さない)", () => {
		expect(extractAnthropicTrace(undefined)).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
		expect(extractAnthropicTrace([null, "text", 42])).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
	});
});

describe("extractGptTrace", () => {
	it("search / open_page / find_in_page を操作の種類として区別する", () => {
		const trace = extractGptTrace([
			{ type: "reasoning", summary: [] },
			{
				type: "web_search_call",
				status: "completed",
				action: {
					type: "search",
					queries: ["Château Margaux 2015", "margaux cepage"],
					sources: [
						{ type: "url", url: "https://www.chateau-margaux.com/vins" },
						{ type: "url", url: "https://www.vivino.com/margaux" },
					],
				},
			},
			{
				type: "web_search_call",
				status: "completed",
				action: {
					type: "open_page",
					url: "https://www.chateau-margaux.com/vins",
				},
			},
			{
				type: "web_search_call",
				status: "completed",
				action: {
					type: "find_in_page",
					url: "https://www.chateau-margaux.com/vins",
					pattern: "encépagement",
				},
			},
		]);
		expect(trace.steps).toEqual([
			{
				action: "search",
				// 1回の呼び出しで複数語を投げることがあるので連結して残す
				query: "Château Margaux 2015 | margaux cepage",
				urls: [
					"https://www.chateau-margaux.com/vins",
					"https://www.vivino.com/margaux",
				],
				urlCount: 2,
			},
			{
				action: "open",
				urls: ["https://www.chateau-margaux.com/vins"],
				urlCount: 1,
			},
			{
				action: "find",
				query: "encépagement",
				urls: ["https://www.chateau-margaux.com/vins"],
				urlCount: 1,
			},
		]);
		expect(trace.hosts).toEqual(["www.chateau-margaux.com", "www.vivino.com"]);
	});

	it("非推奨の単数形 query もフォールバックとして拾う", () => {
		const trace = extractGptTrace([
			{ type: "web_search_call", action: { type: "search", query: "q" } },
		]);
		expect(trace.steps[0]).toEqual({ action: "search", query: "q" });
	});

	it("sources が無い(include 未指定)場合も検索語だけは残す", () => {
		// include: ["web_search_call.action.sources"] を付け忘れるとこの形になる
		const trace = extractGptTrace([
			{
				type: "web_search_call",
				status: "completed",
				action: { type: "search", queries: ["q"] },
			},
		]);
		expect(trace.steps[0]).toEqual({ action: "search", query: "q" });
		expect(trace.hosts).toEqual([]);
	});

	it("失敗した検索に error を立てる", () => {
		const trace = extractGptTrace([
			{
				type: "web_search_call",
				status: "failed",
				action: { type: "search", queries: ["q"] },
			},
		]);
		expect(trace.steps[0]?.error).toBe("failed");
	});

	it("web_search_call 以外のアイテムは無視し、空でも throw しない", () => {
		expect(
			extractGptTrace([
				{ type: "message", content: [{ type: "output_text", text: "{}" }] },
				null,
				"x",
			]),
		).toEqual({ steps: [], stepCount: 0, hosts: [] });
		expect(extractGptTrace(undefined)).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
	});

	it("解釈できないURLはホスト要約から落ちるが、軌跡には残る", () => {
		const trace = extractGptTrace([
			{
				type: "web_search_call",
				action: {
					type: "search",
					queries: ["q"],
					sources: [{ url: "not a url" }],
				},
			},
		]);
		expect(trace.steps[0]?.urls).toEqual(["not a url"]);
		expect(trace.hosts).toEqual([]);
	});
});
