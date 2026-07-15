import { describe, expect, it } from "vitest";
import { createReferenceLinkInput, updateReferenceLinkInput } from "./schema";

describe("createReferenceLinkInput", () => {
	it("http/https のURLを受け付ける", () => {
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "https://example.com/ambonnay",
			}).success,
		).toBe(true);
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "http://example.com",
				title: "アンボネイ解説",
			}).success,
		).toBe(true);
	});

	it("http/https 以外のスキームは弾く", () => {
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				// biome-ignore lint/suspicious/noExplicitAny: テスト用に不正値を渡す
				url: "javascript:alert(1)" as any,
			}).success,
		).toBe(false);
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "ftp://example.com/file",
			}).success,
		).toBe(false);
	});

	it("URLでない文字列は弾く", () => {
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "not a url",
			}).success,
		).toBe(false);
	});

	it("aopId はスラッグ形式のみ", () => {
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "Ambonnay!",
				url: "https://example.com",
			}).success,
		).toBe(false);
	});

	it("title は前後空白を除去し、空文字は弾く", () => {
		const ok = createReferenceLinkInput.safeParse({
			aopId: "ambonnay",
			url: "https://example.com",
			title: "  記事  ",
		});
		expect(ok.success).toBe(true);
		if (ok.success) expect(ok.data.title).toBe("記事");

		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "https://example.com",
				title: "   ",
			}).success,
		).toBe(false);
	});

	it("長すぎるURL/titleは弾く", () => {
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: `https://example.com/${"a".repeat(2100)}`,
			}).success,
		).toBe(false);
		expect(
			createReferenceLinkInput.safeParse({
				aopId: "ambonnay",
				url: "https://example.com",
				title: "a".repeat(201),
			}).success,
		).toBe(false);
	});
});

describe("updateReferenceLinkInput", () => {
	it("id のみでも通る(差分更新)", () => {
		expect(updateReferenceLinkInput.safeParse({ id: "abc" }).success).toBe(
			true,
		);
	});

	it("title に null(クリア)を指定できる", () => {
		const r = updateReferenceLinkInput.safeParse({
			id: "abc",
			title: null,
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.title).toBeNull();
	});

	it("url を指定する場合は http/https のみ", () => {
		expect(
			updateReferenceLinkInput.safeParse({
				id: "abc",
				// biome-ignore lint/suspicious/noExplicitAny: テスト用に不正値を渡す
				url: "javascript:alert(1)" as any,
			}).success,
		).toBe(false);
	});
});
