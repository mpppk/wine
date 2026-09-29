import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemotePhoto, parseRemotePhotoUrl } from "./remote-photo";

// web からの銘柄写真の取り込み(#473)の**入口の関門**。URL はモデルの出力であり
// クライアント経由で戻ってくる = 実質的に第三者が指定できるため、ここで通す条件を固定する。
// 取得そのもの(fetchRemotePhoto)は fetch と R2 に触るので workers 側の責務。

describe("parseRemotePhotoUrl", () => {
	it("https の絶対URLだけを通す", () => {
		expect(parseRemotePhotoUrl("https://example.com/a.jpg")?.href).toBe(
			"https://example.com/a.jpg",
		);
		// 平文は中間者に差し替えられる
		expect(parseRemotePhotoUrl("http://example.com/a.jpg")).toBeUndefined();
		expect(parseRemotePhotoUrl("data:image/jpeg;base64,AAAA")).toBeUndefined();
		expect(parseRemotePhotoUrl("/relative/a.jpg")).toBeUndefined();
		expect(parseRemotePhotoUrl("not a url")).toBeUndefined();
		expect(parseRemotePhotoUrl("")).toBeUndefined();
	});

	it("IPリテラル・localhost・内部向けTLDは弾く", () => {
		for (const url of [
			"https://127.0.0.1/a.jpg",
			"https://169.254.169.254/latest/meta-data",
			"https://10.0.0.1/a.jpg",
			"https://[::1]/a.jpg",
			"https://localhost/a.jpg",
			"https://foo.localhost/a.jpg",
			"https://intranet.internal/a.jpg",
			"https://printer.local/a.jpg",
			"https://router.home.arpa/a.jpg",
		]) {
			expect(parseRemotePhotoUrl(url), url).toBeUndefined();
		}
	});

	it("共通ガードの厳しい側に寄せる: 公開IPリテラルも弾く(参考リンクとは逆)", () => {
		// 参考リンク(isFetchableHost)は 8.8.8.8 を許可するが、web画像は既定の
		// 厳しい側なので公開IPでも弾く。同じ質問に2つの答えを出さないための
		// 用途別オプトインの差分(#545)。
		expect(parseRemotePhotoUrl("https://8.8.8.8/a.jpg")).toBeUndefined();
		expect(parseRemotePhotoUrl("https://[2001:db8::1]/a.jpg")).toBeUndefined();
	});

	it("前後の空白は落として受ける(モデル出力は整形されていない)", () => {
		expect(parseRemotePhotoUrl("  https://example.com/a.png  ")?.href).toBe(
			"https://example.com/a.png",
		);
	});

	it("クエリ付きのCDN URLはそのまま通す", () => {
		expect(
			parseRemotePhotoUrl("https://cdn.example.com/x.jpg?w=800&fm=webp")?.href,
		).toBe("https://cdn.example.com/x.jpg?w=800&fm=webp");
	});
});

const PNG_MAGIC = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngResponse(): Response {
	return new Response(PNG_MAGIC, {
		status: 200,
		headers: { "content-type": "image/png" },
	});
}

describe("fetchRemotePhoto", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("リダイレクト先が内部アドレスなら追わず undefined(毎ホップ再検証・#148同等)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// 公開ホストが内部メタデータエンドポイントへ302する典型的なSSRF
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "https://169.254.169.254/latest/meta-data" },
			}),
		);

		expect(await fetchRemotePhoto("https://example.com/a.jpg")).toBeUndefined();

		// 初回(example.com)は fetch するが、内部アドレスへの2ホップ目は fetch しない
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("httpへのダウングレード・リダイレクトは追わない", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 301,
				headers: { location: "http://example.com/a.jpg" },
			}),
		);

		expect(await fetchRemotePhoto("https://example.com/a.jpg")).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("外部ホストへのリダイレクトは追って画像を取得する", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, {
					status: 301,
					headers: { location: "https://cdn.example.com/a.png" },
				}),
			)
			.mockResolvedValueOnce(pngResponse());

		const photo = await fetchRemotePhoto("https://example.com/a.jpg");
		expect(photo?.mimeType).toBe("image/png");
		expect(photo?.url).toBe("https://cdn.example.com/a.png");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
