import { afterEach, describe, expect, it, vi } from "vitest";
import { extractTitleFromHtml, fetchPageTitle } from "./fetch-title";

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

describe("fetchPageTitle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("HTTPエラー時は null を返し hostname 付きで logWarn する(URL全体は残さない)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("nope", { status: 503 }),
		);

		const result = await fetchPageTitle("https://example.com/secret/path?q=1");

		expect(result).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(warn.mock.calls[0]?.[0] as string);
		expect(parsed).toMatchObject({
			level: "warn",
			msg: "page title fetch failed",
			hostname: "example.com",
			status: 503,
		});
		// フルURL(パス・クエリ)はログに載せない。
		expect(warn.mock.calls[0]?.[0]).not.toContain("secret");
	});

	it("SSRFガードで弾かれるホストは fetch せず null(ログも出さない)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(await fetchPageTitle("http://127.0.0.1/")).toBeNull();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});
