import { describe, expect, it } from "vitest";
import { buildWineNote } from "#/lib/drunk-wine/note";
import { NOTE_MAX } from "#/lib/drunk-wine/schema";
import { findProducerInfoByName } from "#/lib/wine/producer-info";
import { AI_LABEL_PROMPT_TOKEN_ESTIMATE } from "./config";
import {
	buildAgentLabelPrompt,
	buildLabelMessages,
	buildLabelSuggestions,
	buildWebLabelPrompt,
	estimateLabelPromptTokens,
	LABEL_JSON_SCHEMA,
	LABEL_PROMPT,
	LABEL_WEB_JSON_SCHEMA,
	type LabelExtraction,
	matchAop,
	matchGrapeVarietyIds,
	matchRegionId,
	mergeExtractions,
	normalizeLabelText,
	parseImageDataUrl,
	parseLabelResponse,
	parseLabelSources,
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
