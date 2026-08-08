import { describe, expect, it } from "vitest";
import { parseRemotePhotoUrl } from "./remote-photo";

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
