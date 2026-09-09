import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PriceList, ReferenceLinksList } from "./ReferenceLinksList";

// カードの展開部と差分ダイアログ(将来はワイン詳細)が共有する表示。
// 3箇所の見た目の一致は、このコンポーネント経由であることで担保する。

afterEach(() => cleanup());

describe("ReferenceLinksList", () => {
	it("タイトル付きリンクを新規タブで開く形で出す", () => {
		render(
			<ReferenceLinksList
				links={[{ url: "https://example.com/a", title: "生産者公式" }]}
			/>,
		);
		const link = screen.getByRole("link", { name: /生産者公式/ });
		expect(link.getAttribute("href")).toBe("https://example.com/a");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel") ?? "").toContain("noreferrer");
	});

	it("タイトルが無ければURLをそのまま出す", () => {
		render(<ReferenceLinksList links={[{ url: "https://example.com/a" }]} />);
		expect(
			screen.getByRole("link", { name: "https://example.com/a" }),
		).toBeTruthy();
	});

	it("空なら何も描かない", () => {
		const { container } = render(<ReferenceLinksList links={[]} />);
		expect(container.firstChild).toBeNull();
	});
});

describe("PriceList", () => {
	it("「金額円(source)」の形で出す", () => {
		render(<PriceList prices={[{ source: "aaa.com", amountJpy: 2000 }]} />);
		expect(screen.getByText("2,000円(aaa.com)")).toBeTruthy();
	});

	it("URLがあれば行ごとリンクにする", () => {
		render(
			<PriceList
				prices={[
					{
						source: "aaa.com",
						amountJpy: 2000,
						url: "https://aaa.com/w/1",
					},
				]}
			/>,
		);
		const link = screen.getByRole("link", { name: /2,000円\(aaa\.com\)/ });
		expect(link.getAttribute("href")).toBe("https://aaa.com/w/1");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel") ?? "").toContain("noreferrer");
	});

	it("金額不明の行は「価格不明」と出す", () => {
		render(<PriceList prices={[{ source: "店頭" }]} />);
		expect(screen.getByText("価格不明(店頭)")).toBeTruthy();
	});

	it("外貨は原通貨のまま記号付きで出す", () => {
		render(
			<PriceList
				prices={[
					{ source: "wine.com", currency: "USD", amount: 25 },
					{ source: "shop.fr", currency: "EUR", amount: 18 },
				]}
			/>,
		);
		expect(screen.getByText("$25(wine.com)")).toBeTruthy();
		expect(screen.getByText("€18(shop.fr)")).toBeTruthy();
	});

	it("記号の無い通貨はコード付きで出す", () => {
		render(
			<PriceList prices={[{ source: "s", currency: "CHF", amount: 30 }]} />,
		);
		expect(screen.getByText("30 CHF(s)")).toBeTruthy();
	});

	it("空なら何も描かない", () => {
		const { container } = render(<PriceList prices={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
