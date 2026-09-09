import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineReferencesValue } from "./drunk-wine-payload";
import { EMPTY_REFERENCES_VALUE } from "./drunk-wine-payload";
import { WineReferencesSection } from "./WineReferencesSection";

// 参考サイト・市場価格の遅延表示(#588)。空の編集画面ではフォームを出さず
// 追加ボタンから開くこと、値があるときは最初から見えることを固定する。

afterEach(() => cleanup());

function renderSection(value: WineReferencesValue = EMPTY_REFERENCES_VALUE) {
	const onChange = vi.fn();
	const rerender = render(
		<WineReferencesSection value={value} onChange={onChange} />,
	).rerender;
	return {
		onChange,
		rerender: (next: WineReferencesValue) => {
			rerender(<WineReferencesSection value={next} onChange={onChange} />);
		},
	};
}

describe("WineReferencesSection", () => {
	it("空のときはフォームを出さず追加ボタンを見せる", () => {
		renderSection();
		expect(
			screen.getByText("まだ参考サイト・市場価格がありません。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "参考情報を追加" })).toBeTruthy();
		expect(screen.queryByPlaceholderText("https://example.com/...")).toBeNull();
		expect(
			screen.queryByPlaceholderText("店・サイト名(例: ドメイン名)"),
		).toBeNull();
	});

	it("追加ボタンでフォームが出て追加・保存できる", () => {
		const { onChange } = renderSection();
		fireEvent.click(screen.getByRole("button", { name: "参考情報を追加" }));
		fireEvent.change(screen.getByPlaceholderText("https://example.com/..."), {
			target: { value: "https://example.com/a" },
		});
		fireEvent.click(
			screen.getAllByRole("button", { name: "追加" })[0] as HTMLElement,
		);
		expect(onChange).toHaveBeenCalledWith({
			referenceLinks: [{ url: "https://example.com/a" }],
			prices: [],
		});
	});

	it("値があるときは最初からフォームを見せる", () => {
		renderSection({
			referenceLinks: [{ url: "https://example.com/a", title: "公式" }],
			prices: [],
		});
		expect(screen.queryByRole("button", { name: "参考情報を追加" })).toBeNull();
		expect(screen.getByPlaceholderText("https://example.com/...")).toBeTruthy();
	});

	it("空で開いて何も足さなければ閉じるで折りたたみに戻る", () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "参考情報を追加" }));
		expect(screen.getByPlaceholderText("https://example.com/...")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(
			screen.getByText("まだ参考サイト・市場価格がありません。"),
		).toBeTruthy();
		expect(screen.queryByPlaceholderText("https://example.com/...")).toBeNull();
	});

	it("親の値が外部から増えたら自動で開く(再解析の確定など)", () => {
		const { rerender } = renderSection();
		expect(screen.getByRole("button", { name: "参考情報を追加" })).toBeTruthy();
		rerender({
			referenceLinks: [{ url: "https://example.com/a" }],
			prices: [],
		});
		expect(screen.getByPlaceholderText("https://example.com/...")).toBeTruthy();
	});
});
