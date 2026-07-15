import { describe, expect, it } from "vitest";
import { extractTitleFromHtml } from "./fetch-title";

describe("extractTitleFromHtml", () => {
	it("<title> を抽出する", () => {
		expect(
			extractTitleFromHtml(
				"<html><head><title>アンボネイ</title></head></html>",
			),
		).toBe("アンボネイ");
	});

	it("og:title を <title> より優先する", () => {
		const html = `
			<head>
				<title>site title</title>
				<meta property="og:title" content="OGタイトル" />
			</head>`;
		expect(extractTitleFromHtml(html)).toBe("OGタイトル");
	});

	it("og:title は content/property の順序が逆でも取れる", () => {
		const html = `<meta content="逆順OG" property="og:title">`;
		expect(extractTitleFromHtml(html)).toBe("逆順OG");
	});

	it("HTMLエンティティをデコードする", () => {
		expect(
			extractTitleFromHtml("<title>A &amp; B &lt;C&gt; &#39;D&#39;</title>"),
		).toBe("A & B <C> 'D'");
	});

	it("数値実体参照(10進/16進)をデコードする", () => {
		expect(extractTitleFromHtml("<title>&#12354;&#x3044;</title>")).toBe(
			"あい",
		);
	});

	it("改行・連続空白を1つに畳む", () => {
		expect(extractTitleFromHtml("<title>  foo\n\t  bar  </title>")).toBe(
			"foo bar",
		);
	});

	it("200字を超えるタイトルは切り詰める", () => {
		const long = "あ".repeat(300);
		const result = extractTitleFromHtml(`<title>${long}</title>`);
		expect(result).not.toBeNull();
		expect(result?.length).toBe(200);
	});

	it("title が無ければ null", () => {
		expect(
			extractTitleFromHtml("<html><body>no title</body></html>"),
		).toBeNull();
	});

	it("空の <title> は null", () => {
		expect(extractTitleFromHtml("<title>   </title>")).toBeNull();
	});
});
