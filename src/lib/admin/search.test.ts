import { describe, expect, it } from "vitest";
import { clampPage, likeContains, totalPages } from "./search";

describe("likeContains", () => {
	it("通常の検索語を部分一致パターンで包む", () => {
		expect(likeContains("foo")).toBe("%foo%");
	});

	it("空文字列は全件一致パターンになる", () => {
		expect(likeContains("")).toBe("%%");
	});

	it("% をエスケープする", () => {
		expect(likeContains("50%")).toBe("%50\\%%");
	});

	it("_ をエスケープする", () => {
		expect(likeContains("a_b")).toBe("%a\\_b%");
	});

	it("バックスラッシュをエスケープする", () => {
		expect(likeContains("a\\b")).toBe("%a\\\\b%");
	});

	it("複数のメタ文字が混在してもすべてエスケープする", () => {
		expect(likeContains("%_\\")).toBe("%\\%\\_\\\\%");
	});
});

describe("totalPages", () => {
	it("0件でも1ページとして扱う", () => {
		expect(totalPages(0, 20)).toBe(1);
	});

	it("ページサイズちょうどは1ページ", () => {
		expect(totalPages(20, 20)).toBe(1);
	});

	it("ページサイズ+1件で2ページになる", () => {
		expect(totalPages(21, 20)).toBe(2);
	});
});

describe("clampPage", () => {
	it("範囲内のページはそのまま返す", () => {
		expect(clampPage(2, 50, 20)).toBe(2);
	});

	it("0以下は1に丸める", () => {
		expect(clampPage(0, 50, 20)).toBe(1);
	});

	it("最終ページ超過は最終ページに丸める", () => {
		expect(clampPage(99, 50, 20)).toBe(3);
	});

	it("0件のときは常に1", () => {
		expect(clampPage(5, 0, 20)).toBe(1);
	});
});
