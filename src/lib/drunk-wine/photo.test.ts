import { describe, expect, it } from "vitest";
import {
	buildWinePhotoKey,
	decodePhotoBase64,
	MAX_PHOTO_BYTES,
	photoExtForMime,
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
	it("wines/{userId}/{entryId}.{ext} 形式のキーを作る", () => {
		expect(buildWinePhotoKey("u1", "e1", "image/jpeg")).toBe("wines/u1/e1.jpg");
		expect(buildWinePhotoKey("u1", "e1", "image/webp")).toBe(
			"wines/u1/e1.webp",
		);
	});

	it("未対応MIMEを拒否する", () => {
		expect(() => buildWinePhotoKey("u1", "e1", "text/html")).toThrow(
			/Unsupported image type/,
		);
	});

	it("継承プロパティ名のMIMEを拒否する(allowlistすり抜け防止)", () => {
		expect(() => buildWinePhotoKey("u1", "e1", "constructor")).toThrow(
			/Unsupported image type/,
		);
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
