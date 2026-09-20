import { describe, expect, it } from "vitest";
import {
	concatWebResearchTraces,
	extractOpenRouterTrace,
	WEB_RESEARCH_MAX_STEPS,
	WEB_RESEARCH_MAX_URLS_PER_STEP,
} from "./web-research-trace";

// 高精度経路の裏取りを観測するための軌跡抽出。#602 で全経路を OpenRouter の
// chat completions へ集約したため、応答メッセージの `annotations`(url_citation)
// から参照 URL を拾って同じ型へ落とす。検索語クエリは応答に出ない(回数は
// `usage.server_tool_use.web_search_requests` で別に数える)。

describe("extractOpenRouterTrace", () => {
	it("url_citation の URL を検索ステップとして拾う", () => {
		const trace = extractOpenRouterTrace([
			{ type: "text" },
			{
				type: "url_citation",
				url_citation: {
					url: "https://leflaive.fr/vins",
					title: "Vins",
					content: "抜粋",
				},
			},
			{
				type: "url_citation",
				url_citation: { url: "https://www.wine-searcher.com/find/leflaive" },
			},
		]);
		expect(trace.steps).toEqual([
			{
				action: "search",
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

	it("引用が無ければ空の軌跡(検索していない回と区別できる)", () => {
		expect(extractOpenRouterTrace(undefined)).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
		expect(extractOpenRouterTrace([{ type: "text" }])).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
	});

	it("想定外の要素が混ざっても壊れない", () => {
		expect(extractOpenRouterTrace([null, "x", 1, { type: null }, {}])).toEqual({
			steps: [],
			stepCount: 0,
			hosts: [],
		});
	});

	it("URLは上限まで詰め、総数は残す", () => {
		const annotations = Array.from({ length: 8 }, (_, i) => ({
			type: "url_citation",
			url_citation: { url: `https://example.com/${i}` },
		}));
		const trace = extractOpenRouterTrace(annotations);
		expect(trace.steps[0]?.urls).toHaveLength(WEB_RESEARCH_MAX_URLS_PER_STEP);
		expect(trace.steps[0]?.urlCount).toBe(8);
	});
});

describe("concatWebResearchTraces", () => {
	it("複数リクエストぶんを実行順に連結する", () => {
		const trace = concatWebResearchTraces([
			extractOpenRouterTrace([
				{
					type: "url_citation",
					url_citation: { url: "https://a.example/x" },
				},
			]),
			extractOpenRouterTrace(undefined),
			extractOpenRouterTrace([
				{
					type: "url_citation",
					url_citation: { url: "https://b.example/y" },
				},
			]),
		]);
		expect(trace.stepCount).toBe(2);
		expect(trace.hosts).toEqual(["a.example", "b.example"]);
	});

	it("操作数が上限を超えたら切る(総数は残す)", () => {
		const traces = Array.from({ length: WEB_RESEARCH_MAX_STEPS + 5 }, (_, i) =>
			extractOpenRouterTrace([
				{
					type: "url_citation",
					url_citation: { url: `https://${i}.example/` },
				},
			]),
		);
		const trace = concatWebResearchTraces(traces);
		expect(trace.steps).toHaveLength(WEB_RESEARCH_MAX_STEPS);
		expect(trace.stepCount).toBe(WEB_RESEARCH_MAX_STEPS + 5);
	});
});
