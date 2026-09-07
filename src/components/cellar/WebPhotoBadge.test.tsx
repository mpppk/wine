import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WebPhotoBadge } from "./WebPhotoBadge";

// WEB由来の表示はギャラリー・1枚表示の overlay に一本化した。文言・見た目の
// ドリフトをここで固定する。

afterEach(() => cleanup());

describe("WebPhotoBadge", () => {
	it("overlay は画像の左上に重ねる chip で、読み上げは親に任せる", () => {
		const { container } = render(<WebPhotoBadge variant="overlay" />);
		const badge = container.firstElementChild;
		expect(badge?.textContent).toContain("WEB");
		expect(badge?.getAttribute("aria-hidden")).toBe("true");
		expect(badge?.className).toContain("absolute");
	});
});
