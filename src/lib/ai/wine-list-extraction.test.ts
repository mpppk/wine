import { describe, expect, it } from "vitest";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { AI_WINE_LIST_MAX_WINES } from "./config";
import {
	buildWineListCandidates,
	buildWineListMessages,
	buildWineListPrompt,
	dedupeWineListItems,
	type ExistingWineIdentity,
	estimateWineListReserveTokens,
	matchExistingEntries,
	parseWineListResponse,
	type WineListItem,
	wineIdentityKey,
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

describe("estimateWineListReserveTokens", () => {
	it("枚数に比例し、上限でクランプされる", () => {
		expect(estimateWineListReserveTokens(1)).toBeLessThan(
			estimateWineListReserveTokens(5),
		);
		expect(
			estimateWineListReserveTokens(MAX_PHOTOS_PER_IMPORT_BATCH),
		).toBeLessThanOrEqual(AI_MAX_ESTIMATE_TOKENS);
	});

	it("上限枚数を超える指定でも見積は増えない(境界を跨いだ過大予約を作らない)", () => {
		expect(
			estimateWineListReserveTokens(MAX_PHOTOS_PER_IMPORT_BATCH + 10),
		).toBe(estimateWineListReserveTokens(MAX_PHOTOS_PER_IMPORT_BATCH));
	});

	it("0枚でも1枚ぶんの下限を割らない", () => {
		expect(estimateWineListReserveTokens(0)).toBe(
			estimateWineListReserveTokens(1),
		);
	});
});
