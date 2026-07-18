import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	buildLabelMessages,
	buildLabelSuggestions,
	estimateLabelReserveTokens,
	LABEL_PROMPT,
	type LabelExtraction,
	matchAop,
	matchGrapeVarietyIds,
	matchRegionId,
	normalizeLabelText,
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

describe("parseLabelResponse", () => {
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
	it("呼称からAOP・地域を解決し、テキスト項目をそのまま候補にする", () => {
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
		expect(s.regionId).toBe("bourgogne");
		expect(s.grapeVarietyIds).toEqual(["chardonnay"]);
	});

	it("AOPが解決できないときは地域テキストだけで地域を候補にする", () => {
		const s = buildLabelSuggestions(
			extraction({ wineName: "Some Wine", region: "Burgundy" }),
		);
		expect(s.aopId).toBeUndefined();
		expect(s.regionId).toBe("bourgogne");
	});

	it("品種が無記載でもAOPの主要品種が1種ならそれを候補にする", () => {
		const s = buildLabelSuggestions(extraction({ appellation: "Chablis" }));
		expect(s.aopId).toBe("chablis");
		expect(s.grapeVarietyIds).toEqual(["chardonnay"]);
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
		const estimate = estimateLabelReserveTokens();
		expect(estimate).toBeGreaterThan(0);
		expect(estimate).toBeLessThanOrEqual(AI_MAX_ESTIMATE_TOKENS);
	});
});
