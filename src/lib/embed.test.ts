import { describe, expect, it } from "vitest";
import { isEmbedPath } from "./embed";

describe("isEmbedPath", () => {
	it("埋め込みビューを判定する", () => {
		expect(isEmbedPath("/embed")).toBe(true);
		expect(isEmbedPath("/embed/map")).toBe(true);
		expect(isEmbedPath("/embed/drunk-wine")).toBe(true);
	});

	it("前方一致の別ルートを巻き込まない", () => {
		expect(isEmbedPath("/embedded")).toBe(false);
		expect(isEmbedPath("/")).toBe(false);
		expect(isEmbedPath("/cellar")).toBe(false);
	});
});
