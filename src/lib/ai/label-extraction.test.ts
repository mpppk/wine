import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	buildLabelMessages,
	buildLabelSuggestions,
	buildWebLabelPrompt,
	estimateLabelReserveTokens,
	LABEL_PROMPT,
	type LabelExtraction,
	matchAop,
	matchGrapeVarietyIds,
	matchRegionId,
	mergeExtractions,
	normalizeLabelText,
	parseImageDataUrl,
	parseLabelResponse,
} from "./label-extraction";

function extraction(partial: Partial<LabelExtraction>): LabelExtraction {
	return { grapeVarieties: [], ...partial };
}

describe("buildLabelMessages", () => {
	it("指示文と画像data URIを1つのuserメッセージに含める", () => {
		const messages = buildLabelMessages("data:image/jpeg;base64,abc");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content[0]).toEqual({
			type: "text",
			text: LABEL_PROMPT,
		});
		expect(messages[0]?.content[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,abc" },
		});
	});
});

describe("mergeExtractions", () => {
	it("スカラは最初に読み取れた写真の値、品種は和集合を採る", () => {
		const merged = mergeExtractions([
			extraction({
				appellation: "Chablis Premier Cru",
				producer: "Domaine Testut",
				vintage: 2020,
			}),
			extraction({ grapeVarieties: ["Chardonnay"], region: "Bourgogne" }),
		]);
		expect(merged.appellation).toBe("Chablis Premier Cru");
		expect(merged.producer).toBe("Domaine Testut");
		expect(merged.vintage).toBe(2020);
		expect(merged.region).toBe("Bourgogne");
		expect(merged.grapeVarieties).toEqual(["Chardonnay"]);
	});

	it("先頭(代表写真)の値を優先し、後続では上書きしない", () => {
		const merged = mergeExtractions([
			extraction({ wineName: "Front Name" }),
			extraction({ wineName: "Back Name" }),
		]);
		expect(merged.wineName).toBe("Front Name");
	});

	it("品種の重複はまとめる", () => {
		const merged = mergeExtractions([
			extraction({ grapeVarieties: ["Merlot", "Cabernet Sauvignon"] }),
			extraction({ grapeVarieties: ["Merlot"] }),
		]);
		expect(merged.grapeVarieties).toEqual(["Merlot", "Cabernet Sauvignon"]);
	});

	it("空配列でも空の抽出結果を返す", () => {
		expect(mergeExtractions([])).toEqual({ grapeVarieties: [] });
	});
});

describe("LABEL_PROMPT", () => {
	it("マスタの呼称・品種名の一覧を同梱する(照合ヒット率のグラウンディング)", () => {
		// AOPマスタの正式名(aops.json 由来)
		expect(LABEL_PROMPT).toContain("Brouilly");
		expect(LABEL_PROMPT).toContain("Chablis");
		// 品種マスタの現地語名(varieties.ts 由来)
		expect(LABEL_PROMPT).toContain("Pinot noir");
		expect(LABEL_PROMPT).toContain("Chardonnay");
		// ラベルに無い項目の創作を許すルール変更ではない
		expect(LABEL_PROMPT).toContain("ラベルに明記されている場合のみ");
	});
});

describe("parseLabelResponse", () => {
	it("パース済みオブジェクトの応答も受け付ける(guided_json時のWorkers AIの実挙動)", () => {
		// Workers AI は guided_json 指定時に response をJSON文字列ではなく
		// オブジェクトで返すことがある。文字列前提だと TypeError で解析が全滅する。
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: null,
			vintage: 2020,
			appellation: "Chablis",
			region: "Bourgogne",
			grape_varieties: ["Chardonnay"],
		});
		expect(parsed.wineName).toBe("Chablis");
		expect(parsed.vintage).toBe(2020);
	});

	it("文字列でもオブジェクトでもない応答は弾く", () => {
		expect(() => parseLabelResponse(undefined)).toThrow();
		expect(() => parseLabelResponse(42)).toThrow();
		expect(() => parseLabelResponse(null)).toThrow();
	});

	it("素のJSONをパースする", () => {
		const parsed = parseLabelResponse(
			JSON.stringify({
				wine_name: "Chablis Premier Cru Fourchaume",
				producer: "Domaine Testut",
				vintage: 2020,
				appellation: "Chablis Premier Cru",
				region: "Bourgogne",
				grape_varieties: ["Chardonnay"],
			}),
		);
		expect(parsed.wineName).toBe("Chablis Premier Cru Fourchaume");
		expect(parsed.producer).toBe("Domaine Testut");
		expect(parsed.vintage).toBe(2020);
		expect(parsed.appellation).toBe("Chablis Premier Cru");
		expect(parsed.region).toBe("Bourgogne");
		expect(parsed.grapeVarieties).toEqual(["Chardonnay"]);
	});

	it("コードフェンスや前後の文が混ざっていてもJSON部分を取り出す", () => {
		const parsed = parseLabelResponse(
			'以下が結果です。\n```json\n{"wine_name":"Barolo","producer":null,"vintage":null,"appellation":"Barolo","region":null,"grape_varieties":[]}\n```',
		);
		expect(parsed.wineName).toBe("Barolo");
		expect(parsed.producer).toBeUndefined();
	});

	it("null・空文字・プレースホルダ文字列はundefinedに落とす", () => {
		const parsed = parseLabelResponse(
			JSON.stringify({
				wine_name: "  ",
				producer: "unknown",
				vintage: null,
				appellation: null,
				region: "null",
				grape_varieties: null,
			}),
		);
		expect(parsed.wineName).toBeUndefined();
		expect(parsed.producer).toBeUndefined();
		expect(parsed.vintage).toBeUndefined();
		expect(parsed.region).toBeUndefined();
		expect(parsed.grapeVarieties).toEqual([]);
	});

	it("JSONを含まない応答はthrowする", () => {
		expect(() => parseLabelResponse("読み取れませんでした")).toThrow();
		expect(() => parseLabelResponse("{broken")).toThrow();
	});

	it("型が揺れた出力(vintageが文字列/品種が単一文字列)も正規化する", () => {
		// guided_json が完全には効かず型が揺れても、丸ごと弾かず寛容に受ける
		const parsed = parseLabelResponse(
			JSON.stringify({
				wine_name: "Chablis",
				producer: null,
				vintage: "2019",
				appellation: "Chablis",
				region: null,
				grape_varieties: "Chardonnay",
			}),
		);
		expect(parsed.vintage).toBe(2019);
		expect(parsed.grapeVarieties).toEqual(["Chardonnay"]);
	});

	it("数値化できないvintageや想定外の型はその項目だけ捨てる", () => {
		const parsed = parseLabelResponse(
			JSON.stringify({
				wine_name: 123,
				producer: "Domaine",
				vintage: "N/A",
				appellation: "Chablis",
				region: "Bourgogne",
				grape_varieties: [{ x: 1 }],
			}),
		);
		expect(parsed.wineName).toBe("123");
		expect(parsed.vintage).toBeUndefined();
		expect(parsed.grapeVarieties).toEqual([]);
	});
});

describe("normalizeLabelText", () => {
	it("アクセント・大文字・記号を正規化する", () => {
		expect(normalizeLabelText("Gevrey-Chambertin")).toBe("gevrey chambertin");
		expect(normalizeLabelText("Juliénas")).toBe("julienas");
		expect(normalizeLabelText("CHABLIS  Premier Cru")).toBe(
			"chablis premier cru",
		);
	});

	it("日本語の中点は区切りとして扱う", () => {
		expect(normalizeLabelText("シャブリ・プルミエ・クリュ")).toBe(
			"シャブリ プルミエ クリュ",
		);
	});
});

describe("matchAop", () => {
	it("完全一致でAOPを解決する", () => {
		expect(matchAop(["Chablis"])?.id).toBe("chablis");
		expect(matchAop(["Margaux"])?.id).toBe("margaux");
	});

	it("より長い(具体的な)呼称の一致を優先する", () => {
		expect(matchAop(["Chablis Premier Cru"])?.id).toBe("chablis-premier-cru");
		expect(matchAop(["Chablis Grand Cru"])?.id).toBe("chablis-grand-cru");
	});

	it("ワイン名に呼称が含まれるケースも単語境界つきで拾う", () => {
		expect(matchAop(["Gevrey-Chambertin Vieilles Vignes"])?.id).toBe(
			"gevrey-chambertin",
		);
	});

	it("アクセント差を無視して一致する", () => {
		expect(matchAop(["Julienas"])?.id).toBe("julienas");
	});

	it("一致しなければundefined", () => {
		expect(matchAop(["Napa Valley"])).toBeUndefined();
		expect(matchAop([])).toBeUndefined();
	});
});

describe("matchRegionId", () => {
	it("現地語表記・日本語表記・英語別名を解決する", () => {
		expect(matchRegionId(["Bourgogne"])).toBe("bourgogne");
		expect(matchRegionId(["ブルゴーニュ"])).toBe("bourgogne");
		expect(matchRegionId(["Burgundy"])).toBe("bourgogne");
		expect(matchRegionId(["Piedmont"])).toBe("piemonte");
	});

	it("一致しなければundefined", () => {
		expect(matchRegionId(["Mosel"])).toBeUndefined();
	});
});

describe("matchGrapeVarietyIds", () => {
	it("現地語・日本語の品種名をidに解決し、不明品種は落とす", () => {
		expect(
			matchGrapeVarietyIds(["Pinot Noir", "シャルドネ", "Zinfandel"]),
		).toEqual(["pinot-noir", "chardonnay"]);
	});

	it("重複はまとめる", () => {
		expect(matchGrapeVarietyIds(["Gamay", "gamay"])).toEqual(["gamay"]);
	});
});

describe("buildLabelSuggestions", () => {
	it("呼称からAOPを解決し、テキスト項目をそのまま候補にする(産地は最も細かい1つだけ)", () => {
		const s = buildLabelSuggestions(
			extraction({
				wineName: "Chablis Premier Cru Fourchaume",
				producer: "Domaine Testut",
				vintage: 2020,
				appellation: "Chablis Premier Cru",
				region: "Bourgogne",
				grapeVarieties: ["Chardonnay"],
			}),
		);
		expect(s.name).toBe("Chablis Premier Cru Fourchaume");
		expect(s.producer).toBe("Domaine Testut");
		expect(s.vintage).toBe(2020);
		expect(s.aopId).toBe("chablis-premier-cru");
		// AOPが解決できたら地域・国は候補に含めない(保存の排他と同じ形)
		expect(s.regionId).toBeUndefined();
		expect(s.countryId).toBeUndefined();
		expect(s.grapeVarietyIds).toEqual(["chardonnay"]);
	});

	it("AOPが解決できないときは地域テキストだけで地域を候補にする", () => {
		const s = buildLabelSuggestions(
			extraction({ wineName: "Some Wine", region: "Burgundy" }),
		);
		expect(s.aopId).toBeUndefined();
		expect(s.regionId).toBe("bourgogne");
		expect(s.countryId).toBeUndefined();
	});

	it("地域も解決できないときは国を候補にする", () => {
		const s = buildLabelSuggestions(
			extraction({ wineName: "Some Wine", region: "Jura", country: "France" }),
		);
		expect(s.aopId).toBeUndefined();
		expect(s.regionId).toBeUndefined();
		expect(s.countryId).toBe("france");
	});

	it("国が対応外なら産地は候補に含めない", () => {
		const s = buildLabelSuggestions(
			extraction({ wineName: "Rioja Reserva", country: "Spain" }),
		);
		expect(s.aopId).toBeUndefined();
		expect(s.regionId).toBeUndefined();
		expect(s.countryId).toBeUndefined();
	});

	it("品種が無記載でもAOPの主要品種が1種ならそれを候補にする", () => {
		const s = buildLabelSuggestions(extraction({ appellation: "Chablis" }));
		expect(s.aopId).toBe("chablis");
		expect(s.grapeVarietyIds).toEqual(["chardonnay"]);
	});

	it("ワイン名が読めなければAOPの日本語名(→呼称の原文)を名前に補う", () => {
		expect(
			buildLabelSuggestions(extraction({ appellation: "Chablis Premier Cru" }))
				.name,
		).toBe("シャブリ・プルミエ・クリュ");
		expect(
			buildLabelSuggestions(extraction({ appellation: "Napa Valley" })).name,
		).toBe("Napa Valley");
	});

	it("主要品種が複数のAOPでは品種を推測しない", () => {
		// Margaux は principal が複数(カベルネ・ソーヴィニヨン/メルロ)
		const s = buildLabelSuggestions(extraction({ appellation: "Margaux" }));
		expect(s.aopId).toBe("margaux");
		expect(s.grapeVarietyIds).toBeUndefined();
	});

	it("範囲外のヴィンテージは捨てる", () => {
		expect(
			buildLabelSuggestions(extraction({ vintage: 3050 })).vintage,
		).toBeUndefined();
		expect(
			buildLabelSuggestions(extraction({ vintage: 1700 })).vintage,
		).toBeUndefined();
	});

	it("何も読み取れなければ空の候補", () => {
		expect(buildLabelSuggestions(extraction({}))).toEqual({});
	});
});

describe("estimateLabelReserveTokens", () => {
	it("上限以内の正の見積を返す", () => {
		const estimate = estimateLabelReserveTokens(1);
		expect(estimate).toBeGreaterThan(0);
		expect(estimate).toBeLessThanOrEqual(AI_MAX_ESTIMATE_TOKENS);
	});

	it("枚数が増えると見積も増える(上限まで)", () => {
		expect(estimateLabelReserveTokens(3)).toBeGreaterThan(
			estimateLabelReserveTokens(1),
		);
	});

	it("上限を超えない(多数枚でもクランプ)", () => {
		expect(estimateLabelReserveTokens(100)).toBe(AI_MAX_ESTIMATE_TOKENS);
	});

	it("0枚でも下限として1枚ぶんの見積を返す", () => {
		expect(estimateLabelReserveTokens(0)).toBe(estimateLabelReserveTokens(1));
	});
});

// 高精度経路(Claude / GPT)が共有する指示文と data URI の検証。経路ごとに書き分けると
// 「片方だけ裏取りの規範が古い」状態が生まれるため、ここが SSOT。

describe("parseImageDataUrl", () => {
	it("data URI を media type と base64 データに分解する", () => {
		expect(parseImageDataUrl("data:image/jpeg;base64,AAAA")).toEqual({
			mediaType: "image/jpeg",
			data: "AAAA",
		});
		expect(parseImageDataUrl("data:image/webp;base64,x+/=")).toEqual({
			mediaType: "image/webp",
			data: "x+/=",
		});
	});

	it("base64 の data URI 以外は受け付けない", () => {
		expect(() => parseImageDataUrl("https://example.com/a.jpg")).toThrow();
		expect(() => parseImageDataUrl("data:image/jpeg,notbase64")).toThrow();
		expect(() => parseImageDataUrl("data:image/jpeg;base64,")).toThrow();
	});
});

describe("buildWebLabelPrompt", () => {
	it("web検索での裏取りとJSON出力を指示する", () => {
		const prompt = buildWebLabelPrompt();
		expect(prompt).toContain("web検索");
		expect(prompt).toContain("wine_name");
		expect(prompt).toContain("grape_varieties");
	});

	it("マスタの呼称・品種名の一覧を同梱する(照合ヒット率のグラウンディング)", () => {
		const prompt = buildWebLabelPrompt();
		// AOPマスタの正式名(aops.json 由来)
		expect(prompt).toContain("Brouilly");
		expect(prompt).toContain("Chablis");
		// 品種マスタの現地語名(varieties.ts 由来)
		expect(prompt).toContain("Pinot noir");
		expect(prompt).toContain("Chardonnay");
	});
});
