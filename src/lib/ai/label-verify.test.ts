import { describe, expect, it } from "vitest";
import type { LabelExtraction } from "./label-extraction";
import { resolvesToKnownAop, verifyLabelAnswer } from "./label-verify";
import type { WebResearchTrace } from "./web-research-trace";

// エージェントループの停止条件。**モデルの自己申告では止めない**のが設計の要点で、
// #455 の実測では同一写真4回の解析が毎回別の生産者を返し、そのすべてが
// origin: "photo_and_web" と参照URLを伴っていた。
//
// 同時に**過剰に厳しくしない**ことも要件になる。AOPマスタは対応地域ぶんしか無く、
// 未収録の産地は正しく読めても引けない。「マスタに無い = 不合格」にすると、
// 正しい解析を弾いて機能を壊す。

const base: LabelExtraction = { grapeVarieties: [] };

/** 検索して2サイトを参照した軌跡。引用の裏取りの基準にする。 */
const trace: WebResearchTrace = {
	steps: [
		{
			action: "search",
			query: "chablis dauvissat",
			urls: ["https://www.vivino.com/x", "https://example.com/y"],
			urlCount: 2,
		},
	],
	stepCount: 1,
	hosts: ["www.vivino.com", "example.com"],
};

describe("verifyLabelAnswer", () => {
	it("素直な回答は通る", () => {
		expect(
			verifyLabelAnswer({
				...base,
				appellation: "Chablis Grand Cru",
				vintage: 2020,
				grapeVarieties: ["Chardonnay"],
			}),
		).toEqual({ ok: true, problems: [] });
	});

	describe("マスタに無いものを不合格にしない", () => {
		it("呼称がマスタに無くても通る(未収録の産地がある)", () => {
			// AOPマスタは対応地域ぶんしか無い。ここで落とすと、正しく読めた
			// 未対応産地のワインが必ず「解析やり直し」になる。
			const result = verifyLabelAnswer({
				...base,
				appellation: "Napa Valley",
				grapeVarieties: ["Cabernet Sauvignon"],
			});
			expect(result.ok).toBe(true);
		});

		it("品種がマスタに無くても通る(呼称は解決できていても)", () => {
			const result = verifyLabelAnswer({
				...base,
				appellation: "Chablis Grand Cru",
				grapeVarieties: ["未知の品種"],
			});
			expect(result.ok).toBe(true);
		});

		it("根拠を書いていないこと自体は問題にしない", () => {
			expect(
				verifyLabelAnswer({ ...base, appellation: "Chablis" }, { trace }).ok,
			).toBe(true);
		});
	});

	describe("マスタの中で矛盾しているものを落とす", () => {
		it("呼称で認められていない品種を指摘する", () => {
			// シャブリはシャルドネのみ。呼称と品種のどちらかが誤っている。
			const result = verifyLabelAnswer({
				...base,
				appellation: "Chablis Grand Cru",
				grapeVarieties: ["Merlot"],
			});
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.field).toBe("grape_varieties");
			expect(result.problems[0]?.message).toContain("Merlot");
			// 何をすれば直るかまで返す(次のターンの手がかりになる)
			expect(result.problems[0]?.message).toContain("get_appellation");
		});

		it("西暦として不正なヴィンテージを指摘する", () => {
			const result = verifyLabelAnswer({ ...base, vintage: 20 });
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.field).toBe("vintage");
		});

		it("範囲内のヴィンテージは通る", () => {
			expect(verifyLabelAnswer({ ...base, vintage: 1985 }).ok).toBe(true);
		});
	});

	describe("引用の裏取り", () => {
		it("実際に参照したサイトの引用は通る", () => {
			const result = verifyLabelAnswer(
				{ ...base, producer: "Dauvissat" },
				{
					trace,
					fieldSources: {
						producer: {
							origin: "photo_and_web",
							url: "https://www.vivino.com/dauvissat",
						},
					},
				},
			);
			expect(result.ok).toBe(true);
		});

		it("開いていないサイトの引用を落とす(URLの創作)", () => {
			// #455 で観測した失敗の形: 誤答に、それらしいURLが添えられている。
			// 軌跡を持っているのはこちら側だけなので、モデルの内省では代替できない。
			const result = verifyLabelAnswer(
				{ ...base, producer: "架空のシャトー" },
				{
					trace,
					fieldSources: {
						producer: {
							origin: "photo_and_web",
							url: "https://wine-searcher.com/never-visited",
						},
					},
				},
			);
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.message).toContain("開いていないサイト");
		});

		it("検索していないのに web を名乗る回答を落とす", () => {
			const result = verifyLabelAnswer(
				{ ...base, producer: "X" },
				{
					trace: { steps: [], stepCount: 0, hosts: [] },
					fieldSources: {
						producer: { origin: "web", url: "https://example.com/a" },
					},
				},
			);
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.message).toContain(
				"web検索を実行していません",
			);
		});

		it("web を名乗るのにURLが無い回答を落とす", () => {
			const result = verifyLabelAnswer(
				{ ...base, producer: "X" },
				{ trace, fieldSources: { producer: { origin: "web" } } },
			);
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.message).toContain("参照URLがありません");
		});

		it("URLとして解釈できない引用を落とす", () => {
			const result = verifyLabelAnswer(
				{ ...base, producer: "X" },
				{
					trace,
					fieldSources: { producer: { origin: "web", url: "not a url" } },
				},
			);
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.message).toContain("解釈できません");
		});

		it("origin が photo のフィールドは引用を求めない", () => {
			const result = verifyLabelAnswer(
				{ ...base, producer: "X" },
				{ trace, fieldSources: { producer: { origin: "photo" } } },
			);
			expect(result.ok).toBe(true);
		});

		it("origin が unknown のフィールドは引用を求めない", () => {
			const result = verifyLabelAnswer(
				{ ...base },
				{ trace, fieldSources: { vintage: { origin: "unknown" } } },
			);
			expect(result.ok).toBe(true);
		});

		it("検索結果のURLはホスト単位で照合する(同一サイトの別ページを許す)", () => {
			// 検索結果のスニペットから同じサイトの別ページを引用するのは正当。
			// URL完全一致で照合すると誤検知する。
			const result = verifyLabelAnswer(
				{ ...base, producer: "X" },
				{
					trace,
					fieldSources: {
						producer: {
							origin: "web",
							url: "https://www.vivino.com/another/page",
						},
					},
				},
			);
			expect(result.ok).toBe(true);
		});
	});

	it("問題は複数まとめて返す(1ターンで全部直させる)", () => {
		const result = verifyLabelAnswer(
			{
				...base,
				appellation: "Chablis Grand Cru",
				grapeVarieties: ["Merlot"],
				vintage: 12,
			},
			{
				trace,
				fieldSources: {
					producer: { origin: "web", url: "https://nowhere.example/a" },
				},
			},
		);
		expect(result.ok).toBe(false);
		expect(result.problems.length).toBeGreaterThanOrEqual(3);
	});
});

describe("resolvesToKnownAop", () => {
	it("マスタに解決できる呼称は true", () => {
		expect(
			resolvesToKnownAop({ ...base, appellation: "Chablis Grand Cru" }),
		).toBe(true);
	});

	it("マスタ外は false(検証には使わない観測用の指標)", () => {
		expect(resolvesToKnownAop({ ...base, appellation: "Napa Valley" })).toBe(
			false,
		);
	});
});
