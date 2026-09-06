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
	it("「sourceでは金額円」の形で出す", () => {
		render(<PriceList prices={[{ source: "aaa.com", amountJpy: 2000 }]} />);
		expect(screen.getByText("aaa.comでは2,000円")).toBeTruthy();
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
		const link = screen.getByRole("link", { name: /aaa\.comでは2,000円/ });
		expect(link.getAttribute("href")).toBe("https://aaa.com/w/1");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel") ?? "").toContain("noreferrer");
	});

	it("金額不明の行は「価格不明」と出す", () => {
		render(<PriceList prices={[{ source: "店頭" }]} />);
		expect(screen.getByText("店頭では価格不明")).toBeTruthy();
	});

	it("空なら何も描かない", () => {
		const { container } = render(<PriceList prices={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
