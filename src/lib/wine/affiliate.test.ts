import { describe, expect, it } from "vitest";
import {
	buildAmazonSearchUrl,
	buildRakutenSearchUrl,
	getProducerPurchaseLinks,
	getWineryPurchaseLinks,
	isLinkableProducerName,
} from "./affiliate";
import { AOPS } from "./aops-data";
import type { Aop } from "./types";

function wineryAop(partial?: Partial<Aop>): Aop {
	return {
		id: "chateau-test",
		idApp: 911999,
		name: "Château Test",
		shortName: "Château Test",
		nameJa: "シャトー・テスト",
		region: "bordeaux",
		subregionId: "medoc",
		kind: "winery",
		villageAopIds: ["pauillac"],
		colors: ["red"],
		grapes: [{ varietyId: "cabernet-sauvignon", role: "principal" }],
		soil: "-",
		producers: [{ name: "テスト家" }],
		description: "-",
		...partial,
	};
}

describe("buildRakutenSearchUrl", () => {
	it("ID未設定なら楽天市場のワインジャンル内検索URLを返す", () => {
		expect(buildRakutenSearchUrl("Château Thivin", "")).toBe(
			`https://search.rakuten.co.jp/search/mall/${encodeURIComponent("Château Thivin")}/510915/`,
		);
	});

	it("IDが設定されていれば計測用URLでラップする", () => {
		const url = buildRakutenSearchUrl("Salon", "abc.def");
		expect(
			url.startsWith("https://hb.afl.rakuten.co.jp/hgc/abc.def/?pc="),
		).toBe(true);
		// pc / m の両方に検索URLがエンコードされて入る
		expect(
			url.includes(
				encodeURIComponent(
					"https://search.rakuten.co.jp/search/mall/Salon/510915/",
				),
			),
		).toBe(true);
	});
});

describe("buildAmazonSearchUrl", () => {
	it("ID未設定ならAmazon.co.jpの検索URLを返す", () => {
		expect(buildAmazonSearchUrl("Deutz", "")).toBe(
			"https://www.amazon.co.jp/s?k=Deutz",
		);
	});

	it("IDが設定されていればもしもアフィリエイト経由でラップする", () => {
		const url = buildAmazonSearchUrl("Deutz", "12345");
		expect(
			url.startsWith("https://af.moshimo.com/af/c/click?a_id=12345&"),
		).toBe(true);
		expect(
			url.includes(encodeURIComponent("https://www.amazon.co.jp/s?k=Deutz")),
		).toBe(true);
	});
});

describe("getProducerPurchaseLinks", () => {
	it("プレースホルダー表記にはリンクを生成しない", () => {
		expect(isLinkableProducerName("ジロンド県内の多数の生産者")).toBe(false);
		expect(getProducerPurchaseLinks({ name: "多数の家族経営シャトー" })).toBe(
			null,
		);
	});

	it("searchKeyword があればそれで検索する", () => {
		const links = getProducerPurchaseLinks({
			name: "Domaine Test",
			searchKeyword: "ドメーヌ・テスト",
		});
		expect(links?.rakuten).toContain(encodeURIComponent("ドメーヌ・テスト"));
		expect(links?.amazon).toContain(encodeURIComponent("ドメーヌ・テスト"));
	});

	it("共通辞書にある欧文名はカタカナ検索語に変換される", () => {
		const links = getProducerPurchaseLinks({ name: "Domaine Leflaive" });
		expect(links?.rakuten).toContain(
			encodeURIComponent("ドメーヌ・ルフレーヴ"),
		);
	});

	it("辞書に無い名前はそのまま検索語になる", () => {
		const links = getProducerPurchaseLinks({ name: "Guy Breton" });
		expect(links?.rakuten).toContain(encodeURIComponent("Guy Breton"));
	});

	it("手動リンク(links)は自動生成より優先される", () => {
		const links = getProducerPurchaseLinks({
			name: "Domaine Test",
			links: { rakuten: "https://item.rakuten.co.jp/shop/item/" },
		});
		expect(links?.rakuten).toBe("https://item.rakuten.co.jp/shop/item/");
		// 指定の無い方は自動生成のまま
		expect(links?.amazon).toContain(encodeURIComponent("Domaine Test"));
	});
});

describe("getWineryPurchaseLinks", () => {
	it("wineryはシャトー名(nameJa)で検索するリンクを返す", () => {
		const links = getWineryPurchaseLinks(wineryAop());
		expect(links?.rakuten).toContain(encodeURIComponent("シャトー・テスト"));
		expect(links?.amazon).toContain(encodeURIComponent("シャトー・テスト"));
	});

	it("winery以外はnull", () => {
		expect(getWineryPurchaseLinks(wineryAop({ kind: "village" }))).toBe(null);
	});
});

describe("実データとの整合性", () => {
	it("winery以外の全AOPで、少なくとも1つの生産者が購入リンクを持つかプレースホルダーのみ", () => {
		for (const aop of AOPS.filter((a) => a.kind !== "winery")) {
			for (const p of aop.producers) {
				const links = getProducerPurchaseLinks(p);
				if (isLinkableProducerName(p.name)) {
					expect(links, `${aop.id}: ${p.name}`).not.toBe(null);
				} else {
					expect(links, `${aop.id}: ${p.name}`).toBe(null);
				}
			}
		}
	});

	it("全wineryがシャトー自体の購入リンクを持つ", () => {
		for (const aop of AOPS.filter((a) => a.kind === "winery")) {
			expect(getWineryPurchaseLinks(aop), aop.id).not.toBe(null);
		}
	});
});
