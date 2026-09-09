import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineReferencesValue } from "./drunk-wine-payload";
import { EMPTY_REFERENCES_VALUE } from "./drunk-wine-payload";
import { WineReferencesEditor } from "./WineReferencesEditor";

// 解析の参考サイト・市場価格の編集UI。追加・削除が保存用の state に載ることを固定する。

afterEach(() => cleanup());

function renderEditor(value: WineReferencesValue = EMPTY_REFERENCES_VALUE) {
	const onChange = vi.fn();
	render(<WineReferencesEditor value={value} onChange={onChange} />);
	return { onChange };
}

describe("WineReferencesEditor", () => {
	it("参考サイトを追加できる", () => {
		const { onChange } = renderEditor();
		fireEvent.change(screen.getByPlaceholderText("タイトル(任意)"), {
			target: { value: "公式" },
		});
		fireEvent.change(screen.getByPlaceholderText("https://example.com/..."), {
			target: { value: "https://example.com/a" },
		});
		fireEvent.click(
			screen.getAllByRole("button", { name: "追加" })[0] as HTMLElement,
		);
		expect(onChange).toHaveBeenCalledWith({
			referenceLinks: [{ title: "公式", url: "https://example.com/a" }],
			prices: [],
		});
	});

	it("http/https でないURLは足さず理由を出す", () => {
		const { onChange } = renderEditor();
		fireEvent.change(screen.getByPlaceholderText("https://example.com/..."), {
			target: { value: "javascript:alert(1)" },
		});
		fireEvent.click(
			screen.getAllByRole("button", { name: "追加" })[0] as HTMLElement,
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	it("参考サイトを削除できる", () => {
		const { onChange } = renderEditor({
			referenceLinks: [{ url: "https://example.com/a", title: "公式" }],
			prices: [],
		});
		fireEvent.click(
			screen.getByRole("button", { name: /参考サイト「公式」を削除/ }),
		);
		expect(onChange).toHaveBeenCalledWith({ referenceLinks: [], prices: [] });
	});

	it("市場価格を追加できる(外貨は原通貨のまま)", () => {
		const { onChange } = renderEditor();
		fireEvent.change(
			screen.getByPlaceholderText("店・サイト名(例: ドメイン名)"),
			{ target: { value: "Wine Enthusiast" } },
		);
		fireEvent.change(screen.getByPlaceholderText("金額(例: 2000)"), {
			target: { value: "20" },
		});
		// 通貨は既定で円。USDを選ぶ
		fireEvent.click(screen.getByRole("combobox", { name: "通貨" }));
		fireEvent.click(screen.getByRole("option", { name: "$ (USD)" }));
		fireEvent.click(
			screen.getAllByRole("button", { name: "追加" })[1] as HTMLElement,
		);
		expect(onChange).toHaveBeenCalledWith({
			referenceLinks: [],
			prices: [{ source: "Wine Enthusiast", currency: "USD", amount: 20 }],
		});
	});

	it("金額が無ければ足さず理由を出す", () => {
		const { onChange } = renderEditor();
		fireEvent.change(
			screen.getByPlaceholderText("店・サイト名(例: ドメイン名)"),
			{ target: { value: "aaa.com" } },
		);
		fireEvent.click(
			screen.getAllByRole("button", { name: "追加" })[1] as HTMLElement,
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	it("市場価格を削除できる", () => {
		const { onChange } = renderEditor({
			referenceLinks: [],
			prices: [{ source: "aaa.com", amountJpy: 2000 }],
		});
		expect(screen.getByText("2,000円(aaa.com)")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: /価格「2,000円\(aaa\.com\)」を削除/ }),
		);
		expect(onChange).toHaveBeenCalledWith({ referenceLinks: [], prices: [] });
	});
});
