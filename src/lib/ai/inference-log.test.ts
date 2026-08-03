import { describe, expect, it, vi } from "vitest";
import {
	AI_INFERENCE_LOG_MESSAGE,
	buildAiInferenceFields,
	logAiInference,
} from "./inference-log";

// AI推論の実行記録。**成功も1行出す**ことが目的なので、「出るか」「何が出るか」の
// 両方を固定する(成功経路が無言だと「動いている」と「誰も使っていない」を
// 区別できず、運用時に警告の不在を成功の証拠と誤読することになる)。

const base = {
	feature: "label_analysis",
	userId: "u1",
	requestId: "analyze_label:abc",
	durationMs: 1200,
} as const;

describe("buildAiInferenceFields", () => {
	it("フォールバックの有無を route と executedBy から導出する", () => {
		// 意図した経路と実行経路が食い違う = 高精度経路が落ちて拾われた
		expect(
			buildAiInferenceFields({
				...base,
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "workers-ai",
			}).fellBack,
		).toBe(true);

		expect(
			buildAiInferenceFields({
				...base,
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "gpt-luna",
			}).fellBack,
		).toBe(false);
	});

	it("executedBy が無いときは fellBack を出さない", () => {
		// 推論に到達しなかった(blocked/failed)ケースで false を出すと
		// 「フォールバックしなかった」と誤読される
		const fields = buildAiInferenceFields({
			...base,
			outcome: "blocked",
			route: "gpt-luna",
		});
		expect(fields).not.toHaveProperty("fellBack");
		expect(fields).not.toHaveProperty("executedBy");
	});

	it("undefined のフィールドは落として1行を締まった形に保つ", () => {
		const fields = buildAiInferenceFields({
			...base,
			outcome: "ok",
			actualTokens: undefined,
			photoCount: undefined,
		});
		expect(fields).not.toHaveProperty("actualTokens");
		expect(fields).not.toHaveProperty("photoCount");
		expect(fields).toMatchObject({
			feature: "label_analysis",
			userId: "u1",
			requestId: "analyze_label:abc",
			outcome: "ok",
			durationMs: 1200,
		});
	});

	it("載せられるフィールドを全列挙で固定する", () => {
		const fields = buildAiInferenceFields({
			...base,
			outcome: "ok",
			route: "gpt-luna",
			executedBy: "gpt-luna",
			model: "gpt-5.6-luna",
			photoCount: 2,
			actualTokens: 14324,
			costMicroUsd: 38400,
			reservedMicroUsd: 39000,
			webResearch: { steps: [], stepCount: 0, hosts: [] },
			fieldSources: { vintage: { origin: "photo" } },
		});
		// 出るキーを全列挙で固定する。**フィールドを足すとここが必ず落ち、privacy の
		// 再確認を強制する**のがこのテストの主眼。
		//
		// 抽出されたワイン名・質問文・写真を載せる口は無い。一方 webResearch /
		// fieldSources は検索クエリと参照URLを持ち、**そこからは解析した銘柄が復元できる**
		// (inference-log.ts 冒頭に転換の理由と緩和策を書いてある)。この2つ以外に
		// ユーザ由来の値が入る口を増やすときは、同じ判断をやり直すこと。
		expect(Object.keys(fields).sort()).toEqual([
			"actualTokens",
			"costMicroUsd",
			"durationMs",
			"executedBy",
			"feature",
			"fellBack",
			"fieldSources",
			"model",
			"outcome",
			"photoCount",
			"requestId",
			"reservedMicroUsd",
			"route",
			"userId",
			"webResearch",
		]);
	});

	it("裏取りの観測情報は、載せない経路では1行に現れない", () => {
		// 地域Q&A・一括抽出は web検索をしないので、フィールドごと出ないのが正しい
		// (空の軌跡を出すと「検索したが何も見つからなかった」と誤読される)
		const fields = buildAiInferenceFields({
			...base,
			feature: "region_qa",
			outcome: "ok",
		});
		expect(fields).not.toHaveProperty("webResearch");
		expect(fields).not.toHaveProperty("fieldSources");
	});

	it("検索の軌跡と根拠を1行に載せる(経路をまたいで同じ形)", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			logAiInference({
				...base,
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "gpt-luna",
				webResearch: {
					steps: [
						{
							action: "search",
							query: "Trimbach Clos Sainte Hune 2017",
							urls: ["https://www.trimbach.fr/vins/clos-sainte-hune"],
							urlCount: 1,
						},
					],
					stepCount: 1,
					hosts: ["www.trimbach.fr"],
				},
				fieldSources: {
					vintage: { origin: "photo" },
					grape_varieties: {
						origin: "web",
						url: "https://www.trimbach.fr/vins/clos-sainte-hune",
					},
				},
			});
			const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
			// logger の sanitize が配列・入れ子を潰さずJSONに載せること(深さ上限4)
			expect(line.webResearch.steps[0].urls).toEqual([
				"https://www.trimbach.fr/vins/clos-sainte-hune",
			]);
			expect(line.webResearch.hosts).toEqual(["www.trimbach.fr"]);
			expect(line.fieldSources.grape_varieties.origin).toBe("web");
		} finally {
			spy.mockRestore();
		}
	});

	it("err はそのまま渡す(logger 側が cause まで畳んで文字列化する)", () => {
		const err = new Error("boom");
		expect(
			buildAiInferenceFields({ ...base, outcome: "failed", err }).err,
		).toBe(err);
	});
});

describe("logAiInference", () => {
	it("成功は info で1行出す", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			logAiInference({
				...base,
				outcome: "ok",
				route: "gpt-luna",
				executedBy: "gpt-luna",
				model: "gpt-5.6-luna",
				actualTokens: 14324,
			});
			expect(spy).toHaveBeenCalledTimes(1);
			const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
			expect(line).toMatchObject({
				level: "info",
				msg: AI_INFERENCE_LOG_MESSAGE,
				feature: "label_analysis",
				outcome: "ok",
				executedBy: "gpt-luna",
				model: "gpt-5.6-luna",
				fellBack: false,
				actualTokens: 14324,
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("残高不足(blocked)も info で残す(失敗ではない)", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			logAiInference({ ...base, outcome: "blocked", route: "gpt-luna" });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
				level: "info",
				outcome: "blocked",
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("失敗は warn に上げ、例外を文字列化して載せる", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			logAiInference({
				...base,
				outcome: "failed",
				route: "gpt-luna",
				err: new Error("upstream down", { cause: new Error("503") }),
			});
			expect(spy).toHaveBeenCalledTimes(1);
			const line = JSON.parse(spy.mock.calls[0]?.[0] as string);
			expect(line).toMatchObject({
				level: "warn",
				msg: AI_INFERENCE_LOG_MESSAGE,
				outcome: "failed",
			});
			// cause まで辿れていること(#271 の errToString)
			expect(line.err).toContain("upstream down");
			expect(line.err).toContain("503");
		} finally {
			spy.mockRestore();
		}
	});

	it("全経路で同じ msg を使う(横断検索できることが要件)", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			for (const feature of [
				"label_analysis",
				"region_qa",
				"wine_list_analysis",
			] as const) {
				logAiInference({ ...base, feature, outcome: "ok" });
			}
			const msgs = spy.mock.calls.map(
				(c) => JSON.parse(c[0] as string).msg as string,
			);
			expect(msgs).toEqual(Array(3).fill(AI_INFERENCE_LOG_MESSAGE));
		} finally {
			spy.mockRestore();
		}
	});
});
