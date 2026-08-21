import { describe, expect, it } from "vitest";
import { createPhotoRedactor, describeDataUrl } from "./photo-redact";

// Langfuse へ送る入力から写真を外す純ロジック(#514)。寸法パーサは実画像ではなく
// **合成したヘッダ**で固定する(実画像をコミットするとリポジトリが肥えるし、
// ヘッダの境界条件をピンポイントで撃てない)。

function toBase64(bytes: number[]): string {
	return btoa(String.fromCharCode(...bytes));
}

function toDataUrl(bytes: number[], mime = "image/jpeg"): string {
	return `data:${mime};base64,${toBase64(bytes)}`;
}

/** PNG: シグネチャ + IHDR(幅・高さは uint32 BE)。 */
function pngBytes(width: number, height: number): number[] {
	return [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		0,
		0,
		0,
		13, // IHDR の長さ
		0x49,
		0x48,
		0x44,
		0x52, // "IHDR"
		...Array.from({ length: 4 }, (_, i) => (width >>> (24 - i * 8)) & 0xff),
		...Array.from({ length: 4 }, (_, i) => (height >>> (24 - i * 8)) & 0xff),
		8,
		6,
		0,
		0,
		0, // bit depth / color type / 圧縮・フィルタ・インターレース
	];
}

/** JPEG: SOI + SOF0(高さ・幅は uint16 BE)。 */
function jpegBytes(width: number, height: number): number[] {
	return [
		0xff,
		0xd8, // SOI
		0xff,
		0xe0,
		0,
		4,
		0x4a,
		0x46, // APP0(寸法パーサが読み飛ばすセグメント)
		0xff,
		0xc0, // SOF0
		0,
		11, // セグメント長
		8, // 精度
		(height >>> 8) & 0xff,
		height & 0xff,
		(width >>> 8) & 0xff,
		width & 0xff,
		3,
		1,
		0x22,
		0,
		2,
		0x11,
		1,
		3,
		0x11, // 成分指定(ダミー)
	];
}

/** WebP(VP8X): RIFF + WEBP + VP8X + フラグ4バイト + 幅-1/高さ-1(24bit LE)。 */
function webpVp8xBytes(width: number, height: number): number[] {
	const w = width - 1;
	const h = height - 1;
	return [
		0x52,
		0x49,
		0x46,
		0x46, // "RIFF"
		26,
		0,
		0,
		0,
		0x57,
		0x45,
		0x42,
		0x50, // "WEBP"
		0x56,
		0x50,
		0x38,
		0x58, // "VP8X"
		10,
		0,
		0,
		0, // チャンク長
		0,
		0,
		0,
		0, // フラグ
		w & 0xff,
		(w >> 8) & 0xff,
		(w >> 16) & 0xff,
		h & 0xff,
		(h >> 8) & 0xff,
		(h >> 16) & 0xff,
	];
}

describe("describeDataUrl", () => {
	it("JPEG の MIME・寸法・バイト数・ハッシュを返す", async () => {
		const summary = await describeDataUrl(toDataUrl(jpegBytes(2180, 1200)));
		expect(summary).toMatchObject({
			mime: "image/jpeg",
			width: 2180,
			height: 1200,
		});
		// ハッシュは同じ入力なら同じ値(SHA-256 の16進64文字)
		expect(summary?.sha256).toMatch(/^[0-9a-f]{64}$/);
		const again = await describeDataUrl(toDataUrl(jpegBytes(2180, 1200)));
		expect(again?.sha256).toBe(summary?.sha256);
	});

	it("PNG と WebP(VP8X) の寸法を読む", async () => {
		expect(
			await describeDataUrl(toDataUrl(pngBytes(800, 1200), "image/png")),
		).toMatchObject({
			mime: "image/png",
			width: 800,
			height: 1200,
		});
		expect(
			await describeDataUrl(toDataUrl(webpVp8xBytes(640, 480), "image/webp")),
		).toMatchObject({ mime: "image/webp", width: 640, height: 480 });
	});

	it("解釈できない data URI では null(throw しない)", async () => {
		expect(await describeDataUrl("not a data uri")).toBeNull();
		expect(await describeDataUrl("data:image/jpeg;base64,!!!")).toBeNull();
	});
});

describe("createPhotoRedactor", () => {
	it("data URI を要約オブジェクトへ置き換え、他の値はそのまま残す", async () => {
		const jpeg = toDataUrl(jpegBytes(100, 200));
		const redact = await createPhotoRedactor([jpeg]);
		const input = {
			role: "user",
			content: [
				{ type: "text", text: "このラベルを読んで" },
				{ type: "image_url", image_url: { url: jpeg } },
			],
			nested: [{ keep: "me" }],
		};
		const output = redact(input) as {
			role: string;
			content: Array<Record<string, unknown>>;
			nested: Array<Record<string, unknown>>;
		};
		expect(output.role).toBe("user");
		expect(output.content[0]).toEqual({
			type: "text",
			text: "このラベルを読んで",
		});
		const summary = output.content[1] as {
			image_url: { url: { $photo: Record<string, unknown> } };
		};
		expect(summary.image_url.url.$photo).toMatchObject({
			mime: "image/jpeg",
			width: 100,
			height: 200,
		});
		// 元の data URI はどこにも残らない
		expect(JSON.stringify(output)).not.toContain("base64");
		expect((output.nested as unknown[])[0]).toEqual({ keep: "me" });
	});

	it("写像に無い data URI は置き換えない(mask フックの裏門に任せる)", async () => {
		const known = toDataUrl(jpegBytes(100, 200));
		const unknown = toDataUrl(pngBytes(10, 10), "image/png");
		const redact = await createPhotoRedactor([known]);
		const output = redact({ a: known, b: unknown }) as Record<string, string>;
		expect(output.a).toMatchObject({ $photo: expect.anything() });
		expect(output.b).toBe(unknown);
	});
});
