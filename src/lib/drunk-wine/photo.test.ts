import { describe, expect, it } from "vitest";
import { buildWinePhotoKey, decodePhotoBase64, MAX_PHOTO_BYTES } from "./photo";

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
	it("wines/{entryId}.{ext} 形式のキーを作る(userIdは含めない)", () => {
		expect(buildWinePhotoKey("e1", "image/jpeg")).toBe("wines/e1.jpg");
		expect(buildWinePhotoKey("e1", "image/webp")).toBe("wines/e1.webp");
	});

	it("未対応MIMEを拒否する", () => {
		expect(() => buildWinePhotoKey("e1", "text/html")).toThrow(
			/Unsupported image type/,
		);
	});
});
