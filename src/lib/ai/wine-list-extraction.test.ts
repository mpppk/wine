import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_MICRO_USD } from "#/lib/billing/ai-pricing";
import { MONTHLY_CREDITS_FREE } from "#/lib/billing/plans";
import { costToCredits } from "#/lib/credit/credit-math";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import {
	AI_WINE_LIST_MAX_WINES,
	DEFAULT_LABEL_ENGINE,
	estimateWineListReserveCharge,
	LABEL_ENGINE_KEYS,
	resolveWineListRoute,
	WINE_LIST_ROUTE_KEYS,
} from "./config";
import { buildKnownListsSection } from "./label-extraction";
import {
	compileFallbackTemplate,
	WINE_LIST_RESEARCH_PROMPT,
} from "./managed-prompts";
import {
	buildWineListCandidates,
	buildWineListMessages,
	buildWineListPrompt,
	dedupeWineListItems,
	type ExistingWineIdentity,
	matchExistingEntries,
	parseWineListResponse,
	type WineListItem,
	wineIdentityKey,
	wineIdentityKeys,
} from "./wine-list-extraction";

/** モデル出力(銘柄1件)のダミー。省略した項目は null / 空配列。 */
function wineJson(partial: Record<string, unknown>): Record<string, unknown> {
	return {
		wine_name: null,
		producer: null,
		vintage: null,
		appellation: null,
		region: null,
		grape_varieties: [],
		price: null,
		photo_indexes: [],
		...partial,
	};
}

/** パース済みの銘柄1件のダミー。 */
function item(partial: Partial<WineListItem>): WineListItem {
	return { grapeVarieties: [], photoIndexes: [], ...partial };
}

describe("buildWineListPrompt", () => {
	it("写真の枚数と既知マスタのリストを同梱する", () => {
		const prompt = buildWineListPrompt(3);
		expect(prompt).toContain("全3枚");
		expect(prompt).toContain("## 既知の原産地呼称リスト");
		expect(prompt).toContain("## 既知の品種リスト");
		expect(prompt).toContain("photo_indexes");
		expect(prompt).toContain("truncated");
	});

	it("被写体の判定(単一ワイン / リスト)を指示する", () => {
		const prompt = buildWineListPrompt(1);
		expect(prompt).toContain("subject");
		expect(prompt).toContain("single_wine");
		expect(prompt).toContain("wine_list");
	});
});

describe("buildWineListMessages", () => {
	it("写真ごとに直前へ番号のテキストブロックを挟む(photo_indexes の対応づけ)", () => {
		const messages = buildWineListMessages([
			"data:image/jpeg;base64,AAA",
			"data:image/png;base64,BBB",
		]);
		expect(messages).toHaveLength(1);
		const content = messages[0]?.content;
		if (!Array.isArray(content)) throw new Error("unreachable");
		// [指示文, 写真 0, 画像0, 写真 1, 画像1]
		expect(content).toHaveLength(5);
		expect(content[1]).toEqual({ type: "text", text: "写真 0" });
		expect(content[2]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
		});
		expect(content[3]).toEqual({ type: "text", text: "写真 1" });
		expect(content[4]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "BBB" },
		});
	});

	it("data URI でない画像(HTTP URL)は受け付けない", () => {
		expect(() =>
			buildWineListMessages(["https://example.com/list.jpg"]),
		).toThrow();
	});
});

describe("parseWineListResponse", () => {
	it("コードフェンス混じりの応答から銘柄配列を取り出す", () => {
		const raw = [
			"以下が結果です。",
			"```json",
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Chablis Premier Cru Montée de Tonnerre",
						producer: "Domaine Testut",
						vintage: 2020,
						appellation: "Chablis Premier Cru",
						grape_varieties: ["Chardonnay"],
						price: 12000,
						photo_indexes: [0, 1],
					}),
				],
				truncated: false,
			}),
			"```",
		].join("\n");

		const result = parseWineListResponse(raw, 2);
		expect(result.truncated).toBe(false);
		expect(result.wines).toHaveLength(1);
		expect(result.wines[0]).toMatchObject({
			wineName: "Chablis Premier Cru Montée de Tonnerre",
			producer: "Domaine Testut",
			vintage: 2020,
			appellation: "Chablis Premier Cru",
			grapeVarieties: ["Chardonnay"],
			price: 12000,
			photoIndexes: [0, 1],
		});
	});

	it("型が揺れた値(文字列のvintage・桁区切りの価格・単一の写真番号)を正規化する", () => {
		const result = parseWineListResponse(
			{
				wines: [
					wineJson({
						wine_name: "Barolo",
						vintage: "2018",
						price: "6,800円",
						photo_indexes: 1,
						grape_varieties: "Nebbiolo",
					}),
				],
			},
			3,
		);
		expect(result.wines[0]).toMatchObject({
			vintage: 2018,
			price: 6800,
			photoIndexes: [1],
			grapeVarieties: ["Nebbiolo"],
		});
	});

	it("範囲外・重複の写真番号を落として昇順に整える", () => {
		// 1始まりで数える・存在しない写真を指すといったモデルの誤りを、
		// wine_sighting.photoIndex の検証をすり抜ける前にここで落とす
		const result = parseWineListResponse(
			{
				wines: [
					wineJson({ wine_name: "Sancerre", photo_indexes: [2, 0, 0, -1, 9] }),
				],
			},
			2,
		);
		expect(result.wines[0]?.photoIndexes).toEqual([0]);
	});

	it("名前も生産者も呼称も読めなかった行は落とす", () => {
		const result = parseWineListResponse(
			{
				wines: [
					wineJson({ region: "Bourgogne" }),
					wineJson({ wine_name: "Chablis" }),
				],
			},
			1,
		);
		expect(result.wines).toHaveLength(1);
		expect(result.wines[0]?.wineName).toBe("Chablis");
	});

	it("モデルが truncated を立てたらそのまま伝える", () => {
		const result = parseWineListResponse(
			{ wines: [wineJson({ wine_name: "Chablis" })], truncated: true },
			1,
		);
		expect(result.truncated).toBe(true);
	});

	it("件数上限を超えたぶんは切り捨てて truncated を立てる", () => {
		const wines = Array.from({ length: AI_WINE_LIST_MAX_WINES + 5 }, (_, i) =>
			wineJson({ wine_name: `Wine ${i}` }),
		);
		const result = parseWineListResponse({ wines, truncated: false }, 1);
		expect(result.wines).toHaveLength(AI_WINE_LIST_MAX_WINES);
		expect(result.truncated).toBe(true);
	});

	it("JSONを含まない応答は throw する(呼び出し側でクレジット返却)", () => {
		expect(() => parseWineListResponse("解析できませんでした", 1)).toThrow();
	});

	it("被写体が単一ワインなら subject を single_wine にする", () => {
		const result = parseWineListResponse(
			{
				wines: [wineJson({ wine_name: "Chablis" })],
				subject: "single_wine",
				truncated: false,
			},
			1,
		);
		expect(result.subject).toBe("single_wine");
	});

	it.each([
		["未指定", undefined],
		["null", null],
		["未知の値", "bottle_shelf"],
		["真偽値", true],
	])("subject が%sなら wine_list に寄せる", (_label, subject) => {
		const result = parseWineListResponse(
			{
				wines: [wineJson({ wine_name: "Chablis" })],
				subject,
				truncated: false,
			},
			1,
		);
		expect(result.subject).toBe("wine_list");
	});

	it("打ち切りが起きた回は single_wine と自己申告されても wine_list に倒す", () => {
		// 列挙しきれないほど銘柄がある写真を単体登録へ飛ばすと、残りを登録する導線ごと消える
		const result = parseWineListResponse(
			{
				wines: [wineJson({ wine_name: "Chablis" })],
				subject: "single_wine",
				truncated: true,
			},
			1,
		);
		expect(result.subject).toBe("wine_list");
	});
});

describe("wineIdentityKey", () => {
	it("表記ゆれ(大文字小文字・アクセント・記号)を吸収する", () => {
		expect(
			wineIdentityKey({
				producer: "Domaine Testut",
				name: "Chablis",
				vintage: 2020,
			}),
		).toBe(
			wineIdentityKey({
				producer: "DOMAINE  TESTUT",
				name: "Chablis!",
				vintage: 2020,
			}),
		);
	});

	it("ヴィンテージが違えば別の銘柄として扱う", () => {
		expect(wineIdentityKey({ name: "Chablis", vintage: 2020 })).not.toBe(
			wineIdentityKey({ name: "Chablis", vintage: 2019 }),
		);
	});

	it("名前も生産者も無ければ空キー(統合しない印)を返す", () => {
		expect(wineIdentityKey({ vintage: 2020 })).toBe("");
	});
});

describe("dedupeWineListItems", () => {
	it("写真ごとに呼称の切り分けが変わっても1件にまとめる(#435)", () => {
		// 1枚目は名前に呼称を含め、2枚目は呼称を分けて書く——同じ棚を撮った
		// 複数枚でモデルの切り分けが揺れると、同じ銘柄が2件に割れていた
		const { items, mergedCount } = dedupeWineListItems([
			item({
				wineName: 'Barolo "Bussia"',
				producer: "Prunotto",
				vintage: 2018,
				photoIndexes: [0],
			}),
			item({
				wineName: '"Bussia"',
				producer: "Prunotto",
				vintage: 2018,
				appellation: "Barolo",
				photoIndexes: [1],
			}),
		]);
		expect(items).toHaveLength(1);
		expect(mergedCount).toBe(1);
		expect(items[0]?.photoIndexes).toEqual([0, 1]);
	});

	it("同じ呼称・生産者・年でもキュヴェが違えば分けたまま(#435 で緩めすぎない)", () => {
		const { items } = dedupeWineListItems([
			item({
				wineName: "Gevrey-Chambertin",
				producer: "Domaine Rossignol-Trapet",
				vintage: 2019,
				photoIndexes: [0],
			}),
			item({
				wineName: "Vieilles Vignes",
				producer: "Domaine Rossignol-Trapet",
				vintage: 2019,
				appellation: "Gevrey-Chambertin",
				photoIndexes: [0],
			}),
		]);
		expect(items).toHaveLength(2);
	});

	it("写真をまたいだ同一銘柄を1件にまとめ、写真番号は和集合を採る", () => {
		const { items, mergedCount } = dedupeWineListItems([
			item({
				wineName: "Chablis",
				producer: "Domaine Testut",
				vintage: 2020,
				photoIndexes: [0],
				price: 12000,
			}),
			item({
				wineName: "chablis",
				producer: "domaine testut",
				vintage: 2020,
				photoIndexes: [2],
				grapeVarieties: ["Chardonnay"],
			}),
		]);
		expect(items).toHaveLength(1);
		expect(mergedCount).toBe(1);
		expect(items[0]).toMatchObject({
			wineName: "Chablis",
			photoIndexes: [0, 2],
			price: 12000,
			grapeVarieties: ["Chardonnay"],
		});
	});

	it("ヴィンテージ違いは別銘柄として残す", () => {
		const { items, mergedCount } = dedupeWineListItems([
			item({ wineName: "Chablis", vintage: 2020 }),
			item({ wineName: "Chablis", vintage: 2019 }),
		]);
		expect(items).toHaveLength(2);
		expect(mergedCount).toBe(0);
	});

	it("名前も生産者も無い銘柄同士は統合しない(読み取れなかった行が消えない)", () => {
		const { items } = dedupeWineListItems([
			item({ appellation: "Chablis", photoIndexes: [0] }),
			item({ appellation: "Sancerre", photoIndexes: [1] }),
		]);
		expect(items).toHaveLength(2);
	});

	it("入力を破壊しない(呼び出し側の配列を書き換えない)", () => {
		const first = item({ wineName: "Chablis", photoIndexes: [0] });
		dedupeWineListItems([
			first,
			item({ wineName: "Chablis", photoIndexes: [1] }),
		]);
		expect(first.photoIndexes).toEqual([0]);
	});
});

describe("buildWineListCandidates", () => {
	it("銘柄ごとにマスタ突合(呼称・地域・品種)を再利用する", () => {
		const [candidate] = buildWineListCandidates([
			item({
				wineName: "Montée de Tonnerre",
				appellation: "Chablis Premier Cru",
				producer: "Domaine Testut",
				vintage: 2020,
				price: 12000,
				photoIndexes: [1],
			}),
		]);
		expect(candidate?.suggestions.aopId).toBe("chablis-premier-cru");
		// AOPが解決できたら地域は候補に含めない(産地は最も細かい1つだけ)
		expect(candidate?.suggestions.regionId).toBeUndefined();
		// 呼称が品種を規定するケースは主要品種が候補になる(エチケット解析と同じ規則)
		expect(candidate?.suggestions.grapeVarietyIds).toEqual(["chardonnay"]);
		expect(candidate?.price).toBe(12000);
		expect(candidate?.photoIndexes).toEqual([1]);
	});

	it("参考サイト・価格を持ち回る(空なら持たない)", () => {
		const [withRefs] = buildWineListCandidates([
			item({
				wineName: "Chablis",
				photoIndexes: [0],
				referenceLinks: [{ url: "https://example.com/a", title: "t" }],
				prices: [{ source: "aaa.com", amountJpy: 2000 }],
			}),
		]);
		expect(withRefs?.referenceLinks).toEqual([
			{ url: "https://example.com/a", title: "t" },
		]);
		expect(withRefs?.prices).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
		expect(withRefs?.suggestions.referenceLinks).toEqual(
			withRefs?.referenceLinks,
		);
		expect(withRefs?.suggestions.prices).toEqual(withRefs?.prices);

		const [withoutRefs] = buildWineListCandidates([
			item({ wineName: "Chablis", photoIndexes: [0] }),
		]);
		expect(withoutRefs?.referenceLinks).toBeUndefined();
		expect(withoutRefs?.prices).toBeUndefined();
	});
});

describe("matchExistingEntries", () => {
	const existing = (
		partial: Partial<ExistingWineIdentity>,
	): ExistingWineIdentity => ({
		id: "entry-1",
		name: "Chablis",
		status: "finished",
		...partial,
	});

	it("既存セラーの同一銘柄に一致したら existing を付ける(新規作成しない候補)", () => {
		const candidates = buildWineListCandidates([
			item({ wineName: "Chablis", producer: "Domaine Testut", vintage: 2020 }),
		]);
		const [matched] = matchExistingEntries(candidates, [
			existing({ producer: "Domaine Testut", vintage: 2020 }),
		]);
		expect(matched?.existing).toEqual({
			id: "entry-1",
			name: "Chablis",
			vintage: 2020,
			status: "finished",
		});
	});

	it("ヴィンテージが違う既存エントリには一致しない", () => {
		const candidates = buildWineListCandidates([
			item({ wineName: "Chablis", producer: "Domaine Testut", vintage: 2020 }),
		]);
		const [matched] = matchExistingEntries(candidates, [
			existing({ producer: "Domaine Testut", vintage: 2019 }),
		]);
		expect(matched?.existing).toBeUndefined();
	});

	it("突合は自動入力候補(補完後)の値で行う", () => {
		// ワイン名が読めず呼称の日本語名で補われた銘柄は、保存されると
		// その名前になる。補完前の生の抽出値で突き合わせると、同名のエントリが
		// あるのに新規作成されてしまう
		const candidates = buildWineListCandidates([
			item({ appellation: "Chablis Premier Cru", vintage: 2020 }),
		]);
		expect(candidates[0]?.suggestions.name).toBe("シャブリ・プルミエ・クリュ");
		const [matched] = matchExistingEntries(candidates, [
			existing({ name: "シャブリ・プルミエ・クリュ", vintage: 2020 }),
		]);
		expect(matched?.existing?.id).toBe("entry-1");
	});

	it("同じキーの既存が複数あれば先頭(=直近の登録)を採る", () => {
		const candidates = buildWineListCandidates([
			item({ wineName: "Chablis", vintage: 2020 }),
		]);
		const [matched] = matchExistingEntries(candidates, [
			existing({ id: "newer", vintage: 2020 }),
			existing({ id: "older", vintage: 2020 }),
		]);
		expect(matched?.existing?.id).toBe("newer");
	});
});

// #435: モデルが「ワイン名」と「呼称」をどう切り分けるかは実行ごとに変わる。
// 同じ写真を解析し直しただけで別銘柄になると、再解析(#427)のたびに重複が増える。
describe("wineIdentityKeys の loose キー(呼称の切り分けの揺れを吸収する)", () => {
	const keys = (
		name: string | null,
		producer: string | null,
		vintage: number | null,
		aopId: string | null,
	) => wineIdentityKeys({ name, producer, vintage, aopId });

	it("呼称がワイン名に入った回と、呼称側に出た回で同じキーになる", () => {
		// 実測で観測した揺れ: `Barolo "Bussia"` / `"Bussia"`
		const withAppellationInName = keys(
			'Barolo "Bussia"',
			"Prunotto",
			2018,
			"barolo",
		);
		const withAppellationSeparate = keys(
			'"Bussia"',
			"Prunotto",
			2018,
			"barolo",
		);
		expect(withAppellationInName.strict).not.toBe(
			withAppellationSeparate.strict,
		);
		expect(withAppellationInName.loose).toBe(withAppellationSeparate.loose);
	});

	it("名前が呼称そのものの回と、日本語名で補われた回が一致する", () => {
		// wine_name が読めなかった回は buildLabelSuggestions が AOP の日本語名で補う。
		// 同じ写真でも「呼称をそのまま名前に書いた回」と交互に出るので、両者を畳む。
		const asWritten = keys(
			"Chablis Premier Cru",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		const filledFromAop = keys(
			"シャブリ・プルミエ・クリュ",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		expect(asWritten.strict).not.toBe(filledFromAop.strict);
		expect(asWritten.loose).toBe(filledFromAop.loose);
	});

	it("`1er Cru` と `Premier Cru` の綴り違いで分かれない", () => {
		// リストは 1er Cru、マスタは Premier Cru。呼称名の除去が文字列一致なので、
		// 揃えないと `Chablis 1er Cru Montée de Tonnerre` から呼称が落ちない
		const abbreviated = keys(
			"Chablis 1er Cru Montée de Tonnerre",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		const spelledOut = keys(
			"Montée de Tonnerre",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		expect(abbreviated.strict).not.toBe(spelledOut.strict);
		expect(abbreviated.loose).toBe(spelledOut.loose);
	});

	it("名前の末尾にヴィンテージが付いた回とも一致する", () => {
		// `Chablis 1er Cru Montée de Tonnerre 2021` のように年を名前に含める回がある
		const withVintageInName = keys(
			"Chablis 1er Cru Montée de Tonnerre 2021",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		const withoutIt = keys(
			"Montée de Tonnerre",
			"William Fèvre",
			2021,
			"chablis-premier-cru",
		);
		expect(withVintageInName.loose).toBe(withoutIt.loose);
	});

	it("生産者＝銘柄名(シャトー物)は、生産者が空の回とも一致する", () => {
		// モデルが producer を埋める回と空にする回が交互に出る
		const withProducer = keys(
			"Château Gloria",
			"Château Gloria",
			2016,
			"saint-julien",
		);
		const withoutProducer = keys("Château Gloria", null, 2016, "saint-julien");
		expect(withProducer.strict).not.toBe(withoutProducer.strict);
		expect(withProducer.loose).toBe(withoutProducer.loose);
	});

	it("生産者が違えば同じキュヴェ名でも分かれる(生産者を落とすのは名前と同じ場合だけ)", () => {
		expect(
			keys("Vieilles Vignes", "Domaine A", 2019, "gevrey-chambertin").loose,
		).not.toBe(
			keys("Vieilles Vignes", "Domaine B", 2019, "gevrey-chambertin").loose,
		);
	});

	it("同じ呼称・生産者・年でもキュヴェが違えば別銘柄のまま", () => {
		// 緩めすぎると、同じ村の別キュヴェが1件に潰れて片方が消える
		const vieillesVignes = keys(
			"Vieilles Vignes",
			"Domaine Rossignol-Trapet",
			2019,
			"gevrey-chambertin",
		);
		const village = keys(
			"Gevrey-Chambertin",
			"Domaine Rossignol-Trapet",
			2019,
			"gevrey-chambertin",
		);
		expect(vieillesVignes.loose).not.toBe(village.loose);
		expect(vieillesVignes.loose).not.toBe("");
	});

	it("ヴィンテージ違いは別銘柄のまま(#358 の決定を緩めない)", () => {
		expect(keys('Barolo "Bussia"', "Prunotto", 2018, "barolo").loose).not.toBe(
			keys('Barolo "Bussia"', "Prunotto", 2019, "barolo").loose,
		);
	});

	it("呼称が解決できなければ loose キーを作らない", () => {
		expect(keys("Vin de France Rouge", "Domaine X", 2020, null).loose).toBe("");
	});

	it("生産者もキュヴェ名も無ければ loose キーを作らない(別生産者を混ぜない)", () => {
		// 「生産者不明・キュヴェ名なしのバローロ2018」同士が一致すると、別の生産者の
		// ワインに目撃記録が足される
		expect(keys("Barolo", null, 2018, "barolo").loose).toBe("");
	});
});

describe("matchExistingEntries の揺れ吸収(#435)", () => {
	const candidateFor = (item: Partial<WineListItem>) =>
		buildWineListCandidates([
			{ grapeVarieties: [], photoIndexes: [0], ...item },
		]);

	it("呼称の切り分けが変わった再解析でも既存に一致する", () => {
		const entry: ExistingWineIdentity = {
			id: "e1",
			name: 'Barolo "Bussia"',
			producer: "Prunotto",
			vintage: 2018,
			aopId: "barolo",
			status: "spotted",
		};
		const [matched] = matchExistingEntries(
			candidateFor({
				wineName: '"Bussia"',
				producer: "Prunotto",
				vintage: 2018,
				appellation: "Barolo",
			}),
			[entry],
		);
		expect(matched?.existing?.id).toBe("e1");
	});

	it("同じ呼称・生産者・年の別キュヴェは新規のまま", () => {
		const entry: ExistingWineIdentity = {
			id: "e1",
			name: "Gevrey-Chambertin",
			producer: "Domaine Rossignol-Trapet",
			vintage: 2019,
			aopId: "gevrey-chambertin",
			status: "spotted",
		};
		const [matched] = matchExistingEntries(
			candidateFor({
				wineName: "Vieilles Vignes",
				producer: "Domaine Rossignol-Trapet",
				vintage: 2019,
				appellation: "Gevrey-Chambertin",
			}),
			[entry],
		);
		expect(matched?.existing).toBeUndefined();
	});

	it("aopId を持たない既存エントリ(手入力)は従来どおり strict だけで突き合わせる", () => {
		const entry: ExistingWineIdentity = {
			id: "e1",
			name: 'Barolo "Bussia"',
			producer: "Prunotto",
			vintage: 2018,
			status: "spotted",
		};
		const [looseOnly] = matchExistingEntries(
			candidateFor({
				wineName: '"Bussia"',
				producer: "Prunotto",
				vintage: 2018,
				appellation: "Barolo",
			}),
			[entry],
		);
		expect(looseOnly?.existing).toBeUndefined();

		const [exact] = matchExistingEntries(
			candidateFor({
				wineName: 'Barolo "Bussia"',
				producer: "Prunotto",
				vintage: 2018,
			}),
			[entry],
		);
		expect(exact?.existing?.id).toBe("e1");
	});
});

describe("estimateWineListReserveCharge", () => {
	// 既定経路(#426)。枚数に対する性質は経路に依らないので、代表として Luna で見る
	const microUsd = (n: number) =>
		estimateWineListReserveCharge("gpt-luna", n).microUsd;

	it("枚数に比例し、上限でクランプされる", () => {
		expect(microUsd(1)).toBeLessThan(microUsd(5));
		expect(microUsd(MAX_PHOTOS_PER_IMPORT_BATCH)).toBeLessThanOrEqual(
			AI_MAX_ESTIMATE_MICRO_USD,
		);
	});

	it("上限枚数を超える指定でも見積は増えない(境界を跨いだ過大予約を作らない)", () => {
		expect(microUsd(MAX_PHOTOS_PER_IMPORT_BATCH + 10)).toBe(
			microUsd(MAX_PHOTOS_PER_IMPORT_BATCH),
		);
	});

	it("0枚でも1枚ぶんの下限を割らない", () => {
		expect(microUsd(0)).toBe(microUsd(1));
	});

	it("どの経路でも写真1枚の解析は無料会員の月次付与内に収まる", () => {
		// 1枚でも月次付与を超えると、無料会員はこの機能を一度も使えないまま
		// 残高不足で弾かれ続ける。**コスト基準ではこれがモデル選定の制約になる**:
		// claude-opus-5($5/$25)だと1枚で無料枠を超えるため、Claude 経路は
		// claude-sonnet-5($3/$15)を使っている(#355)。モデルや見積の基礎値を
		// 上げるときに気付けるよう、境界をここで固定する。
		for (const route of WINE_LIST_ROUTE_KEYS) {
			expect(
				costToCredits(estimateWineListReserveCharge(route, 1).microUsd),
				route,
			).toBeLessThanOrEqual(MONTHLY_CREDITS_FREE);
		}
	});

	it("既定の GPT 経路は Claude 経路より安い(#426 の主目的)", () => {
		// 一括抽出を Luna 既定にした理由そのもの。Claude 側の単価が下がる等で
		// この関係が崩れたら、既定の選択を見直すべきだと気付けるようにする。
		for (const photos of [1, MAX_PHOTOS_PER_IMPORT_BATCH]) {
			expect(
				estimateWineListReserveCharge("gpt-luna", photos).microUsd,
			).toBeLessThan(
				estimateWineListReserveCharge("web-research", photos).microUsd,
			);
		}
	});
});

describe("resolveWineListRoute", () => {
	const both = { openai: true, anthropic: true };

	it("既定(gpt-luna)は両キーがあれば GPT 経路になる", () => {
		expect(resolveWineListRoute(DEFAULT_LABEL_ENGINE, both)).toBe("gpt-luna");
		expect(DEFAULT_LABEL_ENGINE).toBe("gpt-luna");
	});

	it("Claude を選んでいれば Claude 経路になる", () => {
		expect(resolveWineListRoute("web-research", both)).toBe("web-research");
	});

	it("標準(Workers AI)を選んでいても高精度経路に載せる(降格しない #358)", () => {
		// 一括抽出は Llama 4 Scout では読み取り品質が足りず、降格すると
		// 「大量の欠落・でたらめな銘柄」が出る。Workers AI は返さない。
		expect(resolveWineListRoute("workers-ai", both)).toBe("gpt-luna");
		expect(
			resolveWineListRoute("workers-ai", { openai: false, anthropic: true }),
		).toBe("web-research");
	});

	it("選んだプロバイダのキーが無ければもう一方へ引き継ぐ", () => {
		expect(
			resolveWineListRoute("gpt-luna", { openai: false, anthropic: true }),
		).toBe("web-research");
		expect(
			resolveWineListRoute("web-research", { openai: true, anthropic: false }),
		).toBe("gpt-luna");
	});

	it("どちらのキーも無ければ null(機能ごと使えない)", () => {
		for (const engine of LABEL_ENGINE_KEYS) {
			expect(
				resolveWineListRoute(engine, { openai: false, anthropic: false }),
				engine,
			).toBeNull();
		}
	});
});

// ---- 銘柄ごとの写真の手当て(#473) ----------------------------------------

describe("写真の手当て(bottle_photo_index / image_url / image_note)", () => {
	it("その1本だけを写した写真の番号を採る", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Barolo",
						photo_indexes: [0, 1],
						bottle_photo_index: 1,
					}),
				],
			}),
			2,
		);
		expect(wines[0]?.bottlePhotoIndex).toBe(1);
		// 手元に適切な写真があるなら web からは取りに行かない
		expect(wines[0]?.imageUrl).toBeUndefined();
	});

	it("適切な写真がある銘柄では image_url を採らない(手元の写真が優先)", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Barolo",
						bottle_photo_index: 0,
						image_url: "https://example.com/barolo.jpg",
						image_note: "2019年の画像です",
					}),
				],
			}),
			1,
		);
		expect(wines[0]?.bottlePhotoIndex).toBe(0);
		expect(wines[0]?.imageUrl).toBeUndefined();
		expect(wines[0]?.imageNote).toBeUndefined();
	});

	it("枚数の範囲外の番号は落とす(存在しない写真を指したまま残さない)", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					// 1始まりで数えた回。写真は1枚しか渡していない
					wineJson({ wine_name: "Barolo", bottle_photo_index: 1 }),
					wineJson({ wine_name: "Chablis", bottle_photo_index: -1 }),
				],
			}),
			1,
		);
		expect(wines[0]?.bottlePhotoIndex).toBeUndefined();
		expect(wines[1]?.bottlePhotoIndex).toBeUndefined();
	});

	it("https でないURL・作文された相対URLは候補にしない", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({ wine_name: "A", image_url: "http://example.com/a.jpg" }),
					wineJson({ wine_name: "B", image_url: "/images/b.jpg" }),
					wineJson({ wine_name: "C", image_url: "  " }),
				],
			}),
			1,
		);
		for (const wine of wines) expect(wine.imageUrl).toBeUndefined();
	});

	it("画像URLが無ければ image_note も持たない(画像なしの注記だけ残さない)", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({ wine_name: "A", image_note: "ヴィンテージが違います" }),
				],
			}),
			1,
		);
		expect(wines[0]?.imageNote).toBeUndefined();
	});

	it("画像URLと注記の組は候補へそのまま運ぶ", () => {
		const [candidate] = buildWineListCandidates([
			item({
				wineName: "Barolo",
				imageUrl: "https://example.com/barolo.jpg",
				imageNote: "2019年のラベル画像です",
			}),
		]);
		expect(candidate?.imageUrl).toBe("https://example.com/barolo.jpg");
		expect(candidate?.imageNote).toBe("2019年のラベル画像です");
	});

	it("重複統合では写真の手当ても先勝ちで埋める", () => {
		const { items } = dedupeWineListItems([
			item({ wineName: "Barolo", producer: "X", photoIndexes: [0] }),
			item({
				wineName: "Barolo",
				producer: "X",
				photoIndexes: [1],
				bottlePhotoIndex: 1,
			}),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.bottlePhotoIndex).toBe(1);
		expect(items[0]?.photoIndexes).toEqual([0, 1]);
	});

	it("指示文が3段の優先順(手元の写真 → web画像 → 一括登録の写真)を書いている", () => {
		const prompt = buildWineListPrompt(2);
		expect(prompt).toContain("bottle_photo_index");
		expect(prompt).toContain("image_url");
		expect(prompt).toContain("image_note");
		expect(prompt).toContain("URLを創作しない");
	});
});

// ---- 銘柄ごとのコメント(#493) ---------------------------------------------
// 写真から1本を登録する主要導線はこの一括抽出しか通らないため、#471 のコメントを
// 全銘柄ぶんここでも出す。

describe("一括抽出のコメント", () => {
	it("銘柄ごとに香り・味わいと生産者のコメントを取り出す", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Barolo",
						tasting_comment: "タールと薔薇。堅牢なタンニン。",
						producer_comment: "家族経営のカンティーナ。",
					}),
				],
			}),
			1,
		);
		expect(wines[0]?.tastingComment).toBe("タールと薔薇。堅牢なタンニン。");
		expect(wines[0]?.producerComment).toBe("家族経営のカンティーナ。");
	});

	it("コメントは候補の note に畳まれる(エチケット解析と同じ組み立て)", () => {
		const [candidate] = buildWineListCandidates([
			item({
				wineName: "Barolo",
				tastingComment: "タールと薔薇。",
				producerComment: "家族経営のカンティーナ。",
			}),
		]);
		expect(candidate?.suggestions.note).toContain("【香り・味わい】");
		expect(candidate?.suggestions.note).toContain("タールと薔薇。");
		expect(candidate?.suggestions.note).toContain("【生産者】");
	});

	it("コメントを持たない応答も従来どおりパースできる", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({ wines: [wineJson({ wine_name: "Barolo" })] }),
			1,
		);
		expect(wines[0]?.tastingComment).toBeUndefined();
		expect(wines[0]?.producerComment).toBeUndefined();
	});

	it("コメントの形が壊れていても銘柄は落とさない(付随情報は throw しない)", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [wineJson({ wine_name: "Barolo", tasting_comment: 42 })],
			}),
			1,
		);
		expect(wines).toHaveLength(1);
		expect(wines[0]?.wineName).toBe("Barolo");
	});

	it("重複統合ではコメントも先勝ちで埋める", () => {
		const { items } = dedupeWineListItems([
			item({ wineName: "Barolo", producer: "X" }),
			item({ wineName: "Barolo", producer: "X", tastingComment: "タール。" }),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.tastingComment).toBe("タール。");
	});

	it("指示文は全銘柄ぶんのコメントを求めつつ、簡潔さを要求する", () => {
		const prompt = buildWineListPrompt(2);
		expect(prompt).toContain("tasting_comment");
		expect(prompt).toContain("producer_comment");
		// 80銘柄ぶん積むと出力上限に触れるので、短く保たせるのが歯止め
		expect(prompt).toContain("1〜2文");
		expect(prompt).toContain("引き写さない");
	});
});

// ---- 銘柄ごとの参考サイト・価格(IMPL-3) --------------------------------------
// コメントと同じく「付随情報は throw しない」: 形が崩れていても銘柄は落とさない。

describe("一括抽出の参考サイト・価格", () => {
	it("銘柄ごとに参考サイトと価格を取り出す", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Barolo",
						reference_links: [
							{ title: "Producer", url: "https://example.com/p" },
							{ title: "bad", url: "javascript:alert(1)" },
						],
						prices: [
							{ source: "aaa.com", amount_jpy: 2000, url: null },
							{ source: "", amount_jpy: 1000, url: null },
						],
					}),
				],
			}),
			1,
		);
		expect(wines[0]?.referenceLinks).toEqual([
			{ url: "https://example.com/p", title: "Producer" },
		]);
		expect(wines[0]?.prices).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
	});

	it("書かれていなければ持たない(旧形式の応答も従来どおりパースできる)", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({ wines: [wineJson({ wine_name: "Barolo" })] }),
			1,
		);
		expect(wines[0]?.referenceLinks).toBeUndefined();
		expect(wines[0]?.prices).toBeUndefined();
	});

	it("形が壊れていても銘柄は落とさない", () => {
		const { wines } = parseWineListResponse(
			JSON.stringify({
				wines: [
					wineJson({
						wine_name: "Barolo",
						reference_links: "https://example.com/a",
						prices: 42,
					}),
				],
			}),
			1,
		);
		expect(wines).toHaveLength(1);
		expect(wines[0]?.wineName).toBe("Barolo");
		expect(wines[0]?.referenceLinks).toBeUndefined();
		expect(wines[0]?.prices).toBeUndefined();
	});

	it("重複統合では参考サイト・価格も先勝ちで束ねる", () => {
		const { items } = dedupeWineListItems([
			item({
				wineName: "Barolo",
				producer: "X",
				referenceLinks: [{ url: "https://example.com/a" }],
			}),
			item({
				wineName: "Barolo",
				producer: "X",
				referenceLinks: [
					{ url: "https://example.com/a" },
					{ url: "https://example.com/b" },
				],
				prices: [{ source: "aaa.com", amountJpy: 2000 }],
			}),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.referenceLinks).toEqual([
			{ url: "https://example.com/a" },
			{ url: "https://example.com/b" },
		]);
		expect(items[0]?.prices).toEqual([{ source: "aaa.com", amountJpy: 2000 }]);
	});

	it("指示文は reference_links/prices を求め、創作を禁じる", () => {
		const prompt = buildWineListPrompt(2);
		expect(prompt).toContain("reference_links");
		expect(prompt).toContain("prices");
		expect(prompt).toContain("実際に開いていないURLを書かない");
	});

	it("wine-list-research の fallback は buildWineListPrompt と一致する", () => {
		// 本文のSSOTは Langfuse 側。fallback とコードの食い違いは
		// 「Langfuse が落ちたときだけ違う指示文」になるので固定する。
		for (const photoCount of [1, 3]) {
			expect(
				compileFallbackTemplate(WINE_LIST_RESEARCH_PROMPT.template, {
					known_lists: buildKnownListsSection(),
					photo_count: String(photoCount),
				}),
			).toBe(buildWineListPrompt(photoCount));
		}
	});
});
