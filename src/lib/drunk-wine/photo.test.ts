import { describe, expect, it } from "vitest";
import {
	buildWinePhotoKey,
	decodePhotoBase64,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS_PER_ENTRY,
	photoExtForMime,
	sniffImageMime,
} from "./photo";

describe("decodePhotoBase64", () => {
	it("base64をバイト列にデコードする", () => {
		const bytes = decodePhotoBase64(btoa("hello"), "image/png");
		expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
	});

	it("data URLプレフィックスを許容する", () => {
		const bytes = decodePhotoBase64(
			`data:image/png;base64,${btoa("hi")}`,
			"image/png",
		);
		expect(bytes.length).toBe(2);
	});

	it("未対応MIMEを拒否する", () => {
		expect(() => decodePhotoBase64(btoa("x"), "image/svg+xml")).toThrow(
			/Unsupported image type/,
		);
	});

	it("不正なbase64を拒否する", () => {
		expect(() => decodePhotoBase64("!!!not-base64!!!", "image/png")).toThrow(
			/Invalid base64/,
		);
	});

	it("デコード後5MB超を拒否する", () => {
		// atob前の長さで判定できないため実際に5MB+1のデータを作る
		const big = btoa("a".repeat(MAX_PHOTO_BYTES + 1));
		expect(() => decodePhotoBase64(big, "image/jpeg")).toThrow(/5 MB/);
	});
});

describe("buildWinePhotoKey", () => {
	it("wines/{userId}/{entryId}/{photoId}.{ext} 形式のキーを作る", () => {
		expect(buildWinePhotoKey("u1", "e1", "p1", "image/jpeg")).toBe(
			"wines/u1/e1/p1.jpg",
		);
		expect(buildWinePhotoKey("u1", "e1", "p2", "image/webp")).toBe(
			"wines/u1/e1/p2.webp",
		);
	});

	it("未対応MIMEを拒否する", () => {
		expect(() => buildWinePhotoKey("u1", "e1", "p1", "text/html")).toThrow(
			/Unsupported image type/,
		);
	});

	it("継承プロパティ名のMIMEを拒否する(allowlistすり抜け防止)", () => {
		expect(() => buildWinePhotoKey("u1", "e1", "p1", "constructor")).toThrow(
			/Unsupported image type/,
		);
	});
});

describe("MAX_PHOTOS_PER_ENTRY", () => {
	it("1エントリの写真上限は6枚", () => {
		expect(MAX_PHOTOS_PER_ENTRY).toBe(6);
	});
});

describe("photoExtForMime", () => {
	it("対応MIMEの拡張子を返す", () => {
		expect(photoExtForMime("image/jpeg")).toBe("jpg");
		expect(photoExtForMime("image/png")).toBe("png");
		expect(photoExtForMime("image/webp")).toBe("webp");
		expect(photoExtForMime("image/gif")).toBe("gif");
	});

	it("未対応MIMEは undefined", () => {
		expect(photoExtForMime("image/svg+xml")).toBeUndefined();
		expect(photoExtForMime("text/html")).toBeUndefined();
	});

	// PHOTO_EXT_MAP は plain object。継承プロパティ名を渡すと素の添字アクセスでは
	// truthy 値(関数など)が返り allowlist をすり抜けてしまうため、undefined を返すこと。
	it("継承プロパティ名は undefined を返す", () => {
		for (const key of [
			"constructor",
			"toString",
			"valueOf",
			"hasOwnProperty",
			"__proto__",
			"isPrototypeOf",
		]) {
			expect(photoExtForMime(key)).toBeUndefined();
		}
	});
});

describe("sniffImageMime", () => {
	it("マジックバイトから対応4種のMIMEを判定する", () => {
		expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
			"image/jpeg",
		);
		expect(
			sniffImageMime(
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			),
		).toBe("image/png");
		// "GIF89a"
		expect(
			sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
		).toBe("image/gif");
		// "GIF87a"
		expect(
			sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])),
		).toBe("image/gif");
		// "RIFF????WEBP"
		expect(
			sniffImageMime(
				new Uint8Array([
					0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
					0x50,
				]),
			),
		).toBe("image/webp");
	});

	it("画像でないバイト列(HTML等)は undefined", () => {
		// "<!DOCTYPE" のような偽装 PNG(申告 image/png でも中身はHTML)は弾く
		const html = new TextEncoder().encode("<!DOCTYPE html><script>");
		expect(sniffImageMime(html)).toBeUndefined();
		expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
	});

	it("シグネチャに満たない短いバイト列は undefined", () => {
		expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
		expect(sniffImageMime(new Uint8Array([]))).toBeUndefined();
		// RIFF だが WEBP でない(WAV等)は弾く
		expect(
			sniffImageMime(
				new Uint8Array([
					0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56,
					0x45,
				]),
			),
		).toBeUndefined();
	});
});
