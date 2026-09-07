import { describe, expect, it } from "vitest";
import { buildWineNote } from "#/lib/drunk-wine/note";
import { NOTE_MAX } from "#/lib/drunk-wine/schema";
import { findProducerInfoByName } from "#/lib/wine/producer-info";
import { AI_LABEL_PROMPT_TOKEN_ESTIMATE } from "./config";
import {
	buildAgentLabelPrompt,
	buildKnownGrapesSection,
	buildKnownListsSection,
	buildLabelMessages,
	buildLabelSuggestions,
	buildWebLabelPrompt,
	estimateLabelPromptTokens,
	LABEL_JSON_SCHEMA,
	LABEL_PRICES_MAX,
	LABEL_PROMPT,
	LABEL_REFERENCE_LINKS_MAX,
	LABEL_WEB_JSON_SCHEMA,
	type LabelExtraction,
	matchAop,
	matchGrapeVarietyIds,
	matchRegionId,
	mergeExtractions,
	normalizeLabelText,
	normalizePrices,
	normalizeReferenceLinks,
	parseImageDataUrl,
	parseLabelResponse,
	parseLabelSources,
	toLabelExtraction,
} from "./label-extraction";
import {
	compileFallbackTemplate,
	LABEL_AGENT_RESEARCH_PROMPT,
	LABEL_WEB_RESEARCH_PROMPT,
} from "./managed-prompts";

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
			extraction({ wineName: "Barca Velha", country: "Portugal" }),
		);
		expect(s.aopId).toBeUndefined();
		expect(s.regionId).toBeUndefined();
		expect(s.countryId).toBeUndefined();
	});

	it("スペインの呼称は収録後にAOP候補として解決される", () => {
		const s = buildLabelSuggestions(
			extraction({ wineName: "Rioja Reserva", appellation: "Rioja" }),
		);
		expect(s.aopId).toBe("rioja");
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

describe("estimateLabelPromptTokens", () => {
	// 予約見積は config.ts の定数 AI_LABEL_PROMPT_TOKEN_ESTIMATE を使う(クライアントにも
	// 読ませるため、マスタを引くこのモジュールに依存させられない)。定数が実長を下回ると
	// Workers AI 経路の予約が実費を下回るので、ここで境界を固定する。
	it("指示文の実長が config の見積定数を超えない", () => {
		expect(estimateLabelPromptTokens()).toBeLessThanOrEqual(
			AI_LABEL_PROMPT_TOKEN_ESTIMATE,
		);
	});

	it("マスタ名一覧を含むので自明に小さくはない", () => {
		expect(estimateLabelPromptTokens()).toBeGreaterThan(1_000);
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

	it("許可外のMIMEは受け付けない(SSOT の ALLOWED_PHOTO_TYPES に寄せる)", () => {
		// SVG 等をAIへ送っても画像として扱えず推論が無駄になる。入力欄・保存関門と
		// 同じ許可形式だけを通し、ここで独自の許可表を持たない。
		expect(() => parseImageDataUrl("data:image/svg+xml;base64,AAAA")).toThrow();
		expect(() => parseImageDataUrl("data:image/bmp;base64,AAAA")).toThrow();
		expect(() => parseImageDataUrl("data:text/plain;base64,AAAA")).toThrow();
		for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
			expect(parseImageDataUrl(`data:${mime};base64,AAAA`).mediaType).toBe(
				mime,
			);
		}
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

	it("フィールドごとの根拠(sources)を出力させ、URLの創作を禁じる", () => {
		const prompt = buildWebLabelPrompt();
		expect(prompt).toContain("sources");
		for (const origin of ["photo", "web", "photo_and_web", "unknown"]) {
			expect(prompt).toContain(origin);
		}
		// 参照していないURLを書かれるとログが嘘になる(観測の意味が消える)
		expect(prompt).toContain("URLを創作しない");
	});
});

describe("LABEL_WEB_JSON_SCHEMA", () => {
	it("Workers AI 経路のスキーマは変えず、根拠だけを足した別スキーマにする", () => {
		// guided_json は Llama 4 Scout では完全には効かず、出力上限も 512 と狭い。
		// 裏取りをしない経路に情報量ゼロの根拠を書かせると本体JSONが溢れる危険だけが増える。
		expect(LABEL_JSON_SCHEMA.properties).not.toHaveProperty("sources");
		expect(LABEL_JSON_SCHEMA.required).not.toContain("sources");
	});

	it("本体フィールドは LABEL_JSON_SCHEMA から derive する(片方だけ古くならない)", () => {
		for (const key of LABEL_JSON_SCHEMA.required) {
			expect(LABEL_WEB_JSON_SCHEMA.properties[key]).toBe(
				LABEL_JSON_SCHEMA.properties[key],
			);
			// 根拠のキーは本体フィールドと1対1
			expect(
				LABEL_WEB_JSON_SCHEMA.properties.sources.properties,
			).toHaveProperty(key);
		}
		expect(
			Object.keys(LABEL_WEB_JSON_SCHEMA.properties.sources.properties).sort(),
		).toEqual([...LABEL_JSON_SCHEMA.required].sort());
	});

	it("strict な structured outputs の要件(全項目 required + 追加禁止)を満たす", () => {
		// strict:true は「properties の全キーが required」「additionalProperties:false」を
		// 要求する。満たさないとリクエスト自体が 400 になる。
		const assertStrict = (schema: {
			properties: object;
			required: readonly string[];
			additionalProperties: boolean;
		}) => {
			expect(schema.additionalProperties).toBe(false);
			expect([...schema.required].sort()).toEqual(
				Object.keys(schema.properties).sort(),
			);
		};
		const { sources } = LABEL_WEB_JSON_SCHEMA.properties;
		assertStrict(LABEL_WEB_JSON_SCHEMA);
		assertStrict(sources);
		assertStrict(sources.properties.wine_name);
		// url は省略可ではなく null 許容(strict では optional にできない)
		expect(sources.properties.wine_name.properties.url.type).toEqual([
			"string",
			"null",
		]);
	});
});

describe("parseLabelSources", () => {
	it("フィールドごとの origin と参照URLを取り出す", () => {
		expect(
			parseLabelSources({
				wine_name: "Clos Sainte Hune",
				sources: {
					wine_name: { origin: "photo_and_web", url: "https://trimbach.fr/x" },
					vintage: { origin: "photo", url: null },
					grape_varieties: { origin: "web", url: "https://vivino.com/y" },
					producer: { origin: "unknown", url: null },
				},
			}),
		).toEqual({
			wine_name: { origin: "photo_and_web", url: "https://trimbach.fr/x" },
			vintage: { origin: "photo" },
			grape_varieties: { origin: "web", url: "https://vivino.com/y" },
			producer: { origin: "unknown" },
		});
	});

	it("生の応答文字列(コードフェンス混じり)でも取り出せる", () => {
		const raw = '```json\n{"sources":{"vintage":{"origin":"photo"}}}\n```';
		expect(parseLabelSources(raw)).toEqual({ vintage: { origin: "photo" } });
	});

	it("値そのもの(ワイン名等)は持たない", () => {
		// ログに載るフィールドなので、抽出結果の値を持ち込む口が無いことを固定する
		const sources = parseLabelSources({
			wine_name: "Clos Sainte Hune",
			sources: { wine_name: { origin: "photo", url: null } },
		});
		expect(JSON.stringify(sources)).not.toContain("Clos Sainte Hune");
	});

	it("表記揺れの origin を列挙値へ寄せ、未知の値は unknown にする", () => {
		const sources = parseLabelSources({
			sources: {
				wine_name: { origin: "PHOTO" },
				producer: { origin: "photo+web" },
				// 値がオブジェクトでなく裸の文字列で返ることがある
				region: "web",
				country: { origin: "検索してない" },
			},
		});
		expect(sources).toEqual({
			wine_name: { origin: "photo" },
			producer: { origin: "photo_and_web" },
			region: { origin: "web" },
			country: { origin: "unknown" },
		});
	});

	it("sources が無い・壊れていても throw せず undefined を返す", () => {
		// 観測のための付随情報なので、ここで throw すると「根拠が書けなかっただけ」の回まで
		// 推論失敗として予約返却することになる(観測を足して可用性を下げない)
		expect(parseLabelSources({ wine_name: "x" })).toBeUndefined();
		expect(parseLabelSources({ sources: "なんか文字列" })).toBeUndefined();
		expect(parseLabelSources({ sources: {} })).toBeUndefined();
		expect(parseLabelSources("JSONですらない")).toBeUndefined();
		expect(parseLabelSources(null)).toBeUndefined();
	});

	it("スキーマ外のキーは拾わない(ログに任意のキーを生やさせない)", () => {
		expect(
			parseLabelSources({
				sources: { vintage: { origin: "photo" }, 悪意: { origin: "web" } },
			}),
		).toEqual({ vintage: { origin: "photo" } });
	});
});

// ---- 銘柄のコメント(#471) -------------------------------------------------

describe("コメント(tasting_comment / producer_comment)", () => {
	it("裏取り経路の応答からコメントを取り出す", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: "Domaine Testut",
			vintage: 2020,
			appellation: "Chablis",
			region: "Bourgogne",
			grape_varieties: ["Chardonnay"],
			tasting_comment: "柑橘と火打石。シャープな酸。",
			producer_comment: "シャブリの家族経営ドメーヌ。",
		});
		expect(parsed.tastingComment).toBe("柑橘と火打石。シャープな酸。");
		expect(parsed.producerComment).toBe("シャブリの家族経営ドメーヌ。");
	});

	it("コメントを持たない応答(Workers AI 経路)も従来どおりパースできる", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: null,
			vintage: null,
			appellation: null,
			region: null,
			country: null,
			grape_varieties: [],
		});
		expect(parsed.tastingComment).toBeUndefined();
		expect(parsed.producerComment).toBeUndefined();
	});

	it("「見つかりませんでした」の作文はコメントとして採らない", () => {
		// モデルは null の代わりに文章で返すことがある。そのまま保存すると
		// 中身のないコメントが利用者のセラーに並ぶ。
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			grape_varieties: [],
			tasting_comment: "web検索では評価が見つかりませんでした。",
			producer_comment: "  ",
		});
		expect(parsed.tastingComment).toBeUndefined();
		expect(parsed.producerComment).toBeUndefined();
	});

	it("コメントの形が壊れていても抽出結果は落とさない(付随情報は throw しない)", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			grape_varieties: [],
			tasting_comment: { unexpected: true },
		});
		expect(parsed.wineName).toBe("Chablis");
		expect(parsed.tastingComment).toBeUndefined();
	});

	it("複数写真のマージでは最初に得られたコメントを採る", () => {
		const merged = mergeExtractions([
			extraction({ wineName: "Chablis" }),
			extraction({ tastingComment: "白桃の香り", producerComment: "老舗" }),
			extraction({ tastingComment: "別の写真のコメント" }),
		]);
		expect(merged.tastingComment).toBe("白桃の香り");
		expect(merged.producerComment).toBe("老舗");
	});
});

describe("buildWineNote", () => {
	it("香り・味わいと生産者を見出し付きの段落に畳む", () => {
		expect(
			buildWineNote({ tasting: "柑橘と火打石。", producer: "老舗。" }),
		).toBe("【香り・味わい】\n柑橘と火打石。\n\n【生産者】\n老舗。");
	});

	it("片方だけでも組み立てる / どちらも無ければ undefined", () => {
		expect(buildWineNote({ tasting: "柑橘。" })).toBe(
			"【香り・味わい】\n柑橘。",
		);
		expect(buildWineNote({})).toBeUndefined();
	});

	it("上限を超えたら切り詰める(保存で弾かれる袋小路を作らない)", () => {
		const note = buildWineNote({ tasting: "あ".repeat(NOTE_MAX + 100) });
		expect(note?.length).toBeLessThanOrEqual(NOTE_MAX);
	});
});

describe("buildLabelSuggestions のコメント", () => {
	it("香り・味わいと生産者のコメントを note に畳む", () => {
		const s = buildLabelSuggestions(
			extraction({
				wineName: "Chablis",
				producer: "名も知らぬ生産者",
				tastingComment: "柑橘と火打石。",
				producerComment: "1950年創業の家族経営。",
			}),
		);
		expect(s.note).toContain("【香り・味わい】");
		expect(s.note).toContain("柑橘と火打石。");
		expect(s.note).toContain("1950年創業の家族経営。");
	});

	it("アプリが解説を持っている生産者は、その解説を流用する(モデルの作文より優先)", () => {
		// producer-info.ts の実データを使う。辞書から解説が消えたらこのテストは落ちる。
		const known = findProducerInfoByName("Domaine de la Romanée-Conti");
		expect(known?.info.description).toBeTruthy();
		const s = buildLabelSuggestions(
			extraction({
				wineName: "Romanée-Conti",
				// 表記揺れ(アクセント無し・小文字)でも辞書を引けること
				producer: "domaine de la romanee conti",
				producerComment: "モデルがその場で書いた説明",
			}),
		);
		expect(s.note).toContain(known?.info.description as string);
		expect(s.note).not.toContain("モデルがその場で書いた説明");
	});

	it("コメントが無ければ note を持たない", () => {
		const s = buildLabelSuggestions(extraction({ wineName: "Chablis" }));
		expect(s.note).toBeUndefined();
	});
});

describe("コメントの指示文", () => {
	it("裏取り経路の指示文はコメントの出力を求め、引き写しを禁じる", () => {
		for (const prompt of [buildWebLabelPrompt(), buildAgentLabelPrompt()]) {
			expect(prompt).toContain("tasting_comment");
			expect(prompt).toContain("producer_comment");
			expect(prompt).toContain("引き写さない");
		}
	});

	it("Workers AI 経路の指示文・スキーマにはコメントを載せない(裏取りが無く創作になる)", () => {
		expect(LABEL_PROMPT).not.toContain("tasting_comment");
		expect(LABEL_JSON_SCHEMA.properties).not.toHaveProperty("tasting_comment");
		expect(LABEL_WEB_JSON_SCHEMA.properties).toHaveProperty("tasting_comment");
		expect(LABEL_WEB_JSON_SCHEMA.required).toContain("tasting_comment");
		expect(LABEL_WEB_JSON_SCHEMA.required).toContain("producer_comment");
	});
});

describe("normalizeReferenceLinks", () => {
	it("http/https のURLだけを残し、タイトルを整える", () => {
		expect(
			normalizeReferenceLinks([
				{ title: " Domaine Testut ", url: "https://example.com/a" },
				{ title: null, url: "http://example.com/b" },
			]),
		).toEqual([
			{ url: "https://example.com/a", title: "Domaine Testut" },
			{ url: "http://example.com/b" },
		]);
	});

	it("URLが無い行・http/https でない行・作文URLを落とす", () => {
		expect(
			normalizeReferenceLinks([
				{ title: "URLなし", url: null },
				{ title: "JS", url: "javascript:alert(1)" },
				{ title: "相対", url: "/wines/123" },
				{ title: "空白", url: "  " },
				{ title: "data", url: "data:text/plain,hi" },
				"文字列だけ",
				null,
				42,
			]),
		).toEqual([]);
	});

	it("同じURLの重複を潰し、上限で切り捨てる", () => {
		const input = Array.from({ length: 5 }, (_, i) => ({
			title: `t${i}`,
			url: i < 2 ? "https://example.com/dup" : `https://example.com/${i}`,
		}));
		const out = normalizeReferenceLinks(input);
		expect(out).toHaveLength(LABEL_REFERENCE_LINKS_MAX);
		expect(out.map((l) => l.url)).toEqual([
			"https://example.com/dup",
			"https://example.com/2",
			"https://example.com/3",
		]);
	});

	it("配列でなく単一オブジェクトでも受ける", () => {
		expect(
			normalizeReferenceLinks({ title: "t", url: "https://example.com/a" }),
		).toEqual([{ url: "https://example.com/a", title: "t" }]);
	});

	it("決して throw しない", () => {
		expect(normalizeReferenceLinks(undefined)).toEqual([]);
		expect(normalizeReferenceLinks("https://example.com/a")).toEqual([]);
	});
});

describe("normalizePrices", () => {
	it("店名と金額を整え、URLは http/https だけ残す", () => {
		expect(
			normalizePrices([
				{
					source: " shop-a.com ",
					amount_jpy: 2000,
					url: "https://shop-a.com/w/1",
				},
				{ source: "shop-b", amount_jpy: "3,800円", url: "ftp://x/y" },
				{ source: "shop-c", amount_jpy: null, url: null },
			]),
		).toEqual([
			{
				source: "shop-a.com",
				amountJpy: 2000,
				url: "https://shop-a.com/w/1",
			},
			{ source: "shop-b", amountJpy: 3800 },
		]);
	});

	it("source が無い行・金額が読めない行を落とす", () => {
		expect(
			normalizePrices([
				{ source: "", amount_jpy: 1000 },
				{ source: "s", amount_jpy: 0 },
				{ source: "s", amount_jpy: -500 },
				{ source: "s", amount_jpy: "不明" },
				{ source: "s", amount_jpy: 99_999_999_999 },
				null,
			]),
		).toEqual([]);
	});

	it("同じ店・同じ金額の重複を潰し、上限で切り捨てる", () => {
		const input = Array.from({ length: 5 }, (_, i) => ({
			source: i === 0 ? "dup" : `s${i}`,
			amount_jpy: i === 1 ? 1000 : 2000,
			url: null,
		}));
		// i=0 と i=1 は別キー(dup|2000 vs s1|1000)。5件目は切り捨て。
		const out = normalizePrices(input);
		expect(out).toHaveLength(LABEL_PRICES_MAX);
	});

	it("決して throw しない", () => {
		expect(normalizePrices(undefined)).toEqual([]);
		expect(normalizePrices(42)).toEqual([]);
	});
});

describe("参考サイト・価格の受け取り", () => {
	it("parseLabelResponse が reference_links/prices を正規化して載せる", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: null,
			vintage: 2020,
			appellation: "Chablis",
			region: "Bourgogne",
			grape_varieties: [],
			tasting_comment: null,
			producer_comment: null,
			reference_links: [
				{ title: "t", url: "https://example.com/a" },
				{ title: "bad", url: "javascript:alert(1)" },
			],
			prices: [{ source: "aaa.com", amount_jpy: 2000, url: null }],
			sources: {},
		});
		expect(parsed.referenceLinks).toEqual([
			{ url: "https://example.com/a", title: "t" },
		]);
		expect(parsed.prices).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
	});

	it("書かれていなければ持たない(Workers AI 経路は常に undefined)", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: null,
			vintage: null,
			appellation: null,
			region: null,
			country: null,
			grape_varieties: [],
		});
		expect(parsed.referenceLinks).toBeUndefined();
		expect(parsed.prices).toBeUndefined();
	});

	it("形が崩れていても抽出結果は捨てない(付随情報の欠落に留める)", () => {
		const parsed = parseLabelResponse({
			wine_name: "Chablis",
			producer: null,
			vintage: null,
			appellation: null,
			region: null,
			country: null,
			grape_varieties: [],
			reference_links: "https://example.com/a",
			prices: [{ source: null, amount_jpy: null, url: null }],
		});
		expect(parsed.wineName).toBe("Chablis");
		expect(parsed.referenceLinks).toBeUndefined();
		expect(parsed.prices).toBeUndefined();
	});

	it("mergeExtractions は参考サイト・価格を和集合で束ねる", () => {
		const merged = mergeExtractions([
			extraction({
				referenceLinks: [{ url: "https://example.com/a", title: "a" }],
				prices: [{ source: "s", amountJpy: 1000 }],
			}),
			extraction({
				referenceLinks: [
					{ url: "https://example.com/a", title: "a2" },
					{ url: "https://example.com/b" },
				],
				prices: [
					{ source: "s", amountJpy: 1000 },
					{ source: "s2", amountJpy: 2000 },
				],
			}),
		]);
		expect(merged.referenceLinks).toEqual([
			{ url: "https://example.com/a", title: "a" },
			{ url: "https://example.com/b" },
		]);
		expect(merged.prices).toEqual([
			{ source: "s", amountJpy: 1000 },
			{ source: "s2", amountJpy: 2000 },
		]);
	});

	it("buildLabelSuggestions は参考サイト・価格を持ち回る(フォームには流し込まない)", () => {
		const s = buildLabelSuggestions(
			extraction({
				wineName: "Chablis",
				referenceLinks: [{ url: "https://example.com/a" }],
				prices: [{ source: "aaa.com", amountJpy: 2000 }],
			}),
		);
		expect(s.referenceLinks).toEqual([{ url: "https://example.com/a" }]);
		expect(s.prices).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
	});

	it("toLabelExtraction が空なら持たせない", () => {
		const e = toLabelExtraction({
			grape_varieties: [],
			reference_links: [],
			prices: [],
		});
		expect(e.referenceLinks).toBeUndefined();
		expect(e.prices).toBeUndefined();
	});
});

describe("参考サイト・価格のスキーマ配置", () => {
	it("裏取り経路の指示文は reference_links/prices の出力を求める", () => {
		for (const prompt of [buildWebLabelPrompt(), buildAgentLabelPrompt()]) {
			expect(prompt).toContain("reference_links");
			expect(prompt).toContain("prices");
			expect(prompt).toContain("創作しない");
		}
	});

	it("Workers AI 経路の指示文・スキーマには載せない(裏取りが無く創作になる)", () => {
		expect(LABEL_PROMPT).not.toContain("reference_links");
		expect(LABEL_JSON_SCHEMA.properties).not.toHaveProperty("reference_links");
		expect(LABEL_JSON_SCHEMA.properties).not.toHaveProperty("prices");
		expect(LABEL_WEB_JSON_SCHEMA.properties).toHaveProperty("reference_links");
		expect(LABEL_WEB_JSON_SCHEMA.properties).toHaveProperty("prices");
		expect(LABEL_WEB_JSON_SCHEMA.required).toContain("reference_links");
		expect(LABEL_WEB_JSON_SCHEMA.required).toContain("prices");
	});
});

describe("Langfuse 管理下のプロンプトとの一致(IMPL-3 W3-2)", () => {
	// 本文のSSOTは Langfuse 側だが、取得に失敗した回はコードの fallback で動く。
	// fallback がコードのビルダーと食い違うと「Langfuse が落ちたときだけ違う指示文」
	// になるので、変数を埋めた fallback がビルダー出力と一致することを固定する。
	it("label-web-research の fallback は buildWebLabelPrompt と一致する", () => {
		expect(
			compileFallbackTemplate(LABEL_WEB_RESEARCH_PROMPT.template, {
				known_lists: buildKnownListsSection(),
			}),
		).toBe(buildWebLabelPrompt());
	});

	it("label-agent-research の fallback は buildAgentLabelPrompt と一致する", () => {
		expect(
			compileFallbackTemplate(LABEL_AGENT_RESEARCH_PROMPT.template, {
				known_grapes: buildKnownGrapesSection(),
			}),
		).toBe(buildAgentLabelPrompt());
	});
});
