import { describe, expect, it } from "vitest";
import {
	ALLOWED_PHOTO_TYPES,
	buildWinePhotoKey,
	decodePhotoBase64,
	isPhotoThumbKey,
	MAX_PHOTO_BYTES,
	MAX_PHOTO_SIZE_LABEL,
	MAX_PHOTOS_PER_ENTRY,
	PHOTO_ACCEPT_ATTR,
	PHOTO_FORMATS_LABEL_JA,
	photoExtForMime,
	photoKeyForThumbKey,
	readJpegOrientation,
	resolveStoredPhotoMime,
	sniffImageMime,
	stripImageMetadata,
	thumbKeyForPhotoKey,
} from "./photo";

const PNG_MAGIC = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

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

describe("resolveStoredPhotoMime", () => {
	it("実バイトと申告が一致すれば実MIMEを返す", () => {
		expect(resolveStoredPhotoMime(PNG_MAGIC, "image/png")).toBe("image/png");
		expect(resolveStoredPhotoMime(JPEG_MAGIC, "image/jpeg")).toBe("image/jpeg");
	});

	it("申告と実フォーマットが食い違うファイルを拒否する(なりすまし)", () => {
		// 中身はPNGだが image/jpeg と申告 → undefined
		expect(resolveStoredPhotoMime(PNG_MAGIC, "image/jpeg")).toBeUndefined();
	});

	it("画像でない中身(HTML等)を申告MIME付きでも拒否する", () => {
		const html = new TextEncoder().encode("<!DOCTYPE html><script>alert(1)");
		expect(resolveStoredPhotoMime(html, "image/png")).toBeUndefined();
	});

	it("許可外の申告MIMEを拒否する", () => {
		expect(resolveStoredPhotoMime(PNG_MAGIC, "text/html")).toBeUndefined();
		expect(resolveStoredPhotoMime(PNG_MAGIC, "image/svg+xml")).toBeUndefined();
		// 継承プロパティ名のすり抜けも拒否
		expect(resolveStoredPhotoMime(PNG_MAGIC, "constructor")).toBeUndefined();
	});

	it("非標準エイリアス image/jpg の申告は image/jpeg として扱う(#593)", () => {
		// VivinoのCDNのように image/jpg を返すサイトがある。実体がJPEGなら通す。
		expect(resolveStoredPhotoMime(JPEG_MAGIC, "image/jpg")).toBe("image/jpeg");
		// 実体との一致要求は緩めない(中身PNGを image/jpg と申告したら弾く)。
		expect(resolveStoredPhotoMime(PNG_MAGIC, "image/jpg")).toBeUndefined();
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

// 表示用の定数が許可MIMEの単一情報源から導出されていることを固定する(#257)。
// 形式や上限を変えたときに、accept属性・説明文・エラー文言のどれかだけが
// 旧情報のまま残る(=利用者への誤案内になる)のを防ぐ。
describe("表示用定数の導出", () => {
	it("accept属性は許可MIMEを全て含む", () => {
		const accept = PHOTO_ACCEPT_ATTR.split(",");
		expect(new Set(accept)).toEqual(ALLOWED_PHOTO_TYPES);
	});

	it("形式の表示名は許可MIMEと同数で、拡張子ではなく表示名を並べる", () => {
		const labels = PHOTO_FORMATS_LABEL_JA.split("・");
		expect(labels).toHaveLength(ALLOWED_PHOTO_TYPES.size);
		// image/jpeg の表示は拡張子(jpg)ではなく JPEG
		expect(labels).toContain("JPEG");
		expect(labels).toContain("WebP");
	});

	it("上限サイズの表示は MAX_PHOTO_BYTES から導出する", () => {
		expect(MAX_PHOTO_SIZE_LABEL).toBe(`${MAX_PHOTO_BYTES / 1024 / 1024}MB`);
	});
});

describe("サムネイルキーの導出 (#237)", () => {
	const photoKey = "wines/u1/e1/p1.jpg";

	it("原寸キーから導出し、往復できる", () => {
		const thumb = thumbKeyForPhotoKey(photoKey);
		expect(thumb).toBe("wines/u1/e1/p1.jpg.thumb.jpg");
		expect(photoKeyForThumbKey(thumb)).toBe(photoKey);
		expect(isPhotoThumbKey(thumb)).toBe(true);
		expect(isPhotoThumbKey(photoKey)).toBe(false);
	});

	it("サムネイルキーでなければ原寸キーを復元しない", () => {
		expect(photoKeyForThumbKey(photoKey)).toBeNull();
	});

	it("配信ルートの許可パターン(拡張子)を満たす", () => {
		// /api/images/$ は拡張子で配信可否を判定する。.thumb.jpg は .jpg で終わるので通る。
		expect(thumbKeyForPhotoKey("wines/u1/e1/p1.png")).toMatch(/\.jpg$/);
	});

	it("所有者の判定は原寸キーと同じ経路で通る(セグメント数を変えない)", () => {
		// wines/{userId}/{entryId}/{photoId}.{ext} の4セグメントを保つ
		expect(thumbKeyForPhotoKey(photoKey).split("/")).toHaveLength(4);
	});
});

// 画像メタデータの除去(#641)。アバターは無認証の公開配信なので、GPS等のEXIFを
// サーバ側で落とす。ワイン写真(非公開)も同じ関数で揃える。
describe("stripImageMetadata", () => {
	// GPS付きJPEG(Orientation=6)。SOI→APP0→APP1(Exif)→SOS→EOIの最小構成。
	// Exif内は Orientation=6・DateTimeOriginal・GPS(35°39'30"N 139°41'30"E)。
	const GPS_JPEG = Uint8Array.from(
		atob(
			"/9j/4AAQSkZJRgABAQAAAQABAAD/4QDGRXhpZgAASUkqAAgAAAADABIBAwABAAAABgAAAGmHBAABAAAAMgAAACWIBAABAAAAWAAAAAAAAAABAAOQAgAUAAAARAAAAAAAAAAyMDI0OjA1OjA2IDEyOjM0OjU2AAQAAQACAAIAAABOAAAAAgAFAAMAAACOAAAAAwACAAIAAABFAAAABAAFAAMAAACmAAAAAAAAACMAAAABAAAAJwAAAAEAAAAeAAAAAQAAAIsAAAABAAAAKQAAAAEAAAAeAAAAAQAAAP/aAAYBAQAAPwCqu//Z",
		),
		(c) => c.charCodeAt(0),
	);

	/** バイト列にASCII文字列が含まれるか。 */
	function containsBytes(haystack: Uint8Array, needle: string): boolean {
		const tag = Array.from(needle, (c) => c.charCodeAt(0));
		outer: for (let i = 0; i + tag.length <= haystack.length; i++) {
			for (let j = 0; j < tag.length; j++) {
				if (haystack[i + j] !== tag[j]) continue outer;
			}
			return true;
		}
		return false;
	}

	it("前提: 入力JPEGはGPS・日時・向き(6)を持つ", () => {
		expect(readJpegOrientation(GPS_JPEG)).toBe(6);
		expect(containsBytes(GPS_JPEG, "2024:05:06")).toBe(true);
	});

	it("GPS・日時を除去し、向きは残す(横倒しにしない)", () => {
		const stripped = stripImageMetadata(GPS_JPEG);
		expect(stripped.length).toBeLessThan(GPS_JPEG.length);
		// 日時・GPS由来の文字列が消える
		expect(containsBytes(stripped, "2024:05:06")).toBe(false);
		// 向きは最小EXIFに残る(ブラウザの自動回転が効き続ける)
		expect(readJpegOrientation(stripped)).toBe(6);
		// 画像データ(SOS以降)は無加工
		expect(stripped.subarray(stripped.length - 4)).toEqual(
			GPS_JPEG.subarray(GPS_JPEG.length - 4),
		);
		// 冪等(2回目は何も変わらない)
		expect(stripImageMetadata(stripped)).toEqual(stripped);
	});

	it("向きが無いJPEGはAPP1を丸ごと落とす", () => {
		// SOI + XMPのAPP1(Exifでない) + EOI
		const xmp = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f,
			0x2f, 0x78, 0xff, 0xd9,
		]);
		expect(stripImageMetadata(xmp)).toEqual(
			new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
		);
	});

	it("PNGの所在・作者・日時チャンクを落とし、本文・透過は残す", () => {
		const chunk = (type: string, data: number[]): number[] => {
			const len = data.length;
			return [
				(len >>> 24) & 0xff,
				(len >>> 16) & 0xff,
				(len >>> 8) & 0xff,
				len & 0xff,
				...Array.from(type, (c) => c.charCodeAt(0)),
				...data,
				0,
				0,
				0,
				0, // CRCは検証しないのでダミー
			];
		};
		const ihdr = [
			0,
			0,
			0,
			1,
			0,
			0,
			0,
			1,
			8,
			2,
			0,
			0,
			0, // 1x1 RGB
		];
		const png = new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...chunk("IHDR", ihdr),
			...chunk("tEXt", [...Array.from("Title\0Hi!", (c) => c.charCodeAt(0))]),
			...chunk("eXIf", [0x4d, 0x4d, 0x00, 0x2a]),
			...chunk("IDAT", [0x11, 0x22, 0x33, 0x44]),
			...chunk("IEND", []),
		]);
		const stripped = stripImageMetadata(png);
		expect(containsBytes(stripped, "tEXt")).toBe(false);
		expect(containsBytes(stripped, "eXIf")).toBe(false);
		expect(containsBytes(stripped, "IDAT")).toBe(true);
		expect(Array.from(stripped.subarray(stripped.length - 12))).toEqual(
			Array.from(png.subarray(png.length - 12)),
		);
	});

	it("WebPのEXIF・XMPチャンクを落とし、フラグとRIFFサイズを直す", () => {
		const chunk = (fourcc: string, data: number[]): number[] => {
			const out = [
				...Array.from(fourcc, (c) => c.charCodeAt(0)),
				data.length & 0xff,
				(data.length >> 8) & 0xff,
				(data.length >> 16) & 0xff,
				(data.length >> 24) & 0xff,
				...data,
			];
			if (data.length % 2 === 1) out.push(0);
			return out;
		};
		const body = [
			...chunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			...chunk("EXIF", [1, 2, 3, 4]),
			...chunk("XMP ", [5, 6, 7]),
			...chunk("VP8 ", [8, 9, 10, 11]),
		];
		const riffSize = 4 + body.length;
		const webp = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46,
			riffSize & 0xff,
			(riffSize >> 8) & 0xff,
			(riffSize >> 16) & 0xff,
			(riffSize >> 24) & 0xff,
			0x57,
			0x45,
			0x42,
			0x50,
			...body,
		]);
		const stripped = stripImageMetadata(webp);
		expect(containsBytes(stripped, "EXIF")).toBe(false);
		expect(containsBytes(stripped, "XMP ")).toBe(false);
		expect(containsBytes(stripped, "VP8 ")).toBe(true);
		// VP8Xの存在ビット(EXIF=0x08・XMP=0x04)が落ちる
		expect(stripped[20]).toBe(0x00);
		// RIFFサイズ(全体-8)が付け直される
		const size = new DataView(stripped.buffer, stripped.byteOffset).getUint32(
			4,
			true,
		);
		expect(size).toBe(stripped.length - 8);
	});

	it("GIFのコメント・XMPを落とし、ループ指定と画像は残す", () => {
		const ascii = (s: string): number[] =>
			Array.from(s, (c) => c.charCodeAt(0));
		const gif = new Uint8Array([
			...ascii("GIF89a"),
			0x01,
			0x00,
			0x01,
			0x00,
			0x70,
			0x00,
			0x00, // LSD(GCTなし)
			0x21,
			0xfe,
			0x03,
			...ascii("hi!"),
			0x00, // コメント
			0x21,
			0xff,
			0x0b,
			...ascii("XMP DataXMP"),
			0x04,
			1,
			2,
			3,
			4,
			0x00,
			0x21,
			0xff,
			0x0b,
			...ascii("NETSCAPE2.0"),
			0x03,
			1,
			0,
			0,
			0x00,
			0x2c,
			0,
			0,
			0,
			0,
			1,
			0,
			1,
			0,
			0,
			0x02,
			0x02,
			0xaa,
			0xbb,
			0x00,
			0x3b,
		]);
		const stripped = stripImageMetadata(gif);
		expect(containsBytes(stripped, "hi!")).toBe(false);
		expect(containsBytes(stripped, "XMP Data")).toBe(false);
		expect(containsBytes(stripped, "NETSCAPE2.0")).toBe(true);
		expect(stripped.at(-1)).toBe(0x3b);
	});

	it("壊れた入力は無加工で返す(さらに壊さない)", () => {
		// 長さだけあって実体の無いAPP1
		const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x64]);
		expect(stripImageMetadata(truncated)).toEqual(truncated);
		// PNGのチャンク長が実体を超える
		const badPng = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0x10, 0x00, 0x49,
			0x48, 0x44, 0x52,
		]);
		expect(stripImageMetadata(badPng)).toEqual(badPng);
		// 画像でない入力は触らない
		const text = new TextEncoder().encode("<html>not an image</html>");
		expect(stripImageMetadata(text)).toBe(text);
	});
});

describe("readJpegOrientation", () => {
	it("向きが無い・壊れた入力はnull", () => {
		expect(
			readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
		).toBeNull();
		expect(readJpegOrientation(new Uint8Array([]))).toBeNull();
		expect(
			readJpegOrientation(new TextEncoder().encode("not a jpeg")),
		).toBeNull();
	});
});
