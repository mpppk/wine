import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractTitleFromHtml,
	fetchPageTitle,
	isFetchableHost,
} from "./fetch-title";

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

	it("リダイレクト先が内部アドレスなら追わず null(毎ホップ再検証)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// 公開ホストが内部メタデータエンドポイントへ302リダイレクトする典型的なSSRF
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data/" },
			}),
		);

		expect(await fetchPageTitle("https://example.com/redirector")).toBeNull();

		// 初回(example.com)は fetch するが、内部アドレスへの2ホップ目は fetch しない
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("外部ホストへのリダイレクトは追ってタイトルを取得する", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, {
					status: 301,
					headers: { location: "https://www.example.org/page" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("<title>移動先ページ</title>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
			);

		expect(await fetchPageTitle("https://example.com/old")).toBe(
			"移動先ページ",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

describe("isFetchableHost", () => {
	it("公開ホスト・公開IPは許可する", () => {
		expect(isFetchableHost("example.com")).toBe(true);
		expect(isFetchableHost("8.8.8.8")).toBe(true);
		expect(isFetchableHost("[2001:db8::1]")).toBe(true);
	});

	it("localhost / .local を弾く", () => {
		expect(isFetchableHost("localhost")).toBe(false);
		expect(isFetchableHost("printer.local")).toBe(false);
	});

	it("内部IPv4帯(ループバック・プライベート・リンクローカル)を弾く", () => {
		for (const h of [
			"127.0.0.1",
			"10.0.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"172.16.0.1",
			"172.31.255.255",
			"0.0.0.0",
		]) {
			expect(isFetchableHost(h), h).toBe(false);
		}
	});

	it("IPv6ループバック・未指定・ULA・リンクローカルを弾く", () => {
		for (const h of [
			"[::1]",
			"[::]",
			"[fc00::1]",
			"[fd12:3456::1]",
			"[fe80::1]",
		]) {
			expect(isFetchableHost(h), h).toBe(false);
		}
	});

	it("IPv4-mapped IPv6 で内部アドレスを偽装しても弾く", () => {
		expect(isFetchableHost("[::ffff:127.0.0.1]")).toBe(false);
		expect(isFetchableHost("[::ffff:169.254.169.254]")).toBe(false);
	});
});
