import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WebPhotoBadge } from "./WebPhotoBadge";

// WEB由来の表示は3箇所(ギャラリー・1枚表示・レビューカード)でこの1点に寄せる。
// 文言・見た目のドリフトをここで固定する。

afterEach(() => cleanup());

describe("WebPhotoBadge", () => {
	it("overlay は画像の左上に重ねる chip で、読み上げは親に任せる", () => {
		const { container } = render(<WebPhotoBadge variant="overlay" />);
		const badge = container.firstElementChild;
		expect(badge?.textContent).toContain("WEB");
		expect(badge?.getAttribute("aria-hidden")).toBe("true");
		expect(badge?.className).toContain("absolute");
	});

	it("inline は従来の文字バッジの置き換え(文言は WEB画像)", () => {
		render(<WebPhotoBadge variant="inline" />);
		expect(screen.getByText("WEB画像")).toBeTruthy();
	});
});
