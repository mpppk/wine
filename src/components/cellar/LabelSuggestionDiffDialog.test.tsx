import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabelDiffItem } from "#/components/cellar/label-suggestion-diff";
import { LabelSuggestionDiffDialog } from "./LabelSuggestionDiffDialog";

afterEach(() => cleanup());

const DIFFS: LabelDiffItem[] = [
	{
		key: "producer",
		label: "生産者",
		current: "Dauvissat",
		suggested: "Domaine Dauvissat-Camus",
		patch: { producer: "Domaine Dauvissat-Camus" },
	},
	{
		key: "vintage",
		label: "ヴィンテージ",
		current: "2018",
		suggested: "2019",
		patch: { vintage: "2019" },
	},
];

function renderDialog(diffs: LabelDiffItem[] = DIFFS) {
	const onApply = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<LabelSuggestionDiffDialog
			open={diffs.length > 0}
			diffs={diffs}
			onApply={onApply}
			onOpenChange={onOpenChange}
		/>,
	);
	return { onApply, onOpenChange };
}

describe("LabelSuggestionDiffDialog", () => {
	it("差分の項目をすべてチェック済みで表示する", () => {
		renderDialog();
		expect(
			screen.getByText("今回の解析結果と現在の入力に差分があります"),
		).toBeTruthy();
		expect(
			screen.getByText("Dauvissat → Domaine Dauvissat-Camus"),
		).toBeTruthy();
		expect(screen.getByText("2018 → 2019")).toBeTruthy();
		for (const cb of screen.getAllByRole("checkbox")) {
			expect(cb.getAttribute("aria-checked")).toBe("true");
		}
	});

	it("反映ボタンで、チェックの入った項目だけをonApplyへ渡す", () => {
		const { onApply } = renderDialog();
		fireEvent.click(screen.getByRole("checkbox", { name: /ヴィンテージ/ }));
		fireEvent.click(screen.getByRole("button", { name: "選んだ項目を反映" }));
		expect(onApply).toHaveBeenCalledTimes(1);
		const applied = onApply.mock.calls[0]?.[0] as LabelDiffItem[];
		expect(applied.map((d) => d.key)).toEqual(["producer"]);
	});

	it("全項目のチェックを外すと反映ボタンが無効になる", () => {
		renderDialog();
		for (const cb of screen.getAllByRole("checkbox")) {
			fireEvent.click(cb);
		}
		expect(
			(
				screen.getByRole("button", {
					name: "選んだ項目を反映",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("「そのままにする」でonOpenChange(false)を呼ぶ", () => {
		const { onOpenChange, onApply } = renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "そのままにする" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onApply).not.toHaveBeenCalled();
	});
});
