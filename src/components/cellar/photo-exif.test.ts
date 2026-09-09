import { describe, expect, it } from "vitest";
import {
	exifDateTimeToCalendarDate,
	firstTakenOn,
	parseExifFromBytes,
	readPhotoExif,
} from "./photo-exif";

// 最小JPEG+EXIFの組み立てヘルパ。実機の写真ではなく、パーサが読むべき構造
// (SOI→APP1 Exif→TIFF→IFD0→ExifIFD/GPS IFD)だけを持つ。
// オフセットはカーソルで積み上げ、手計算の固定値は置かない。

interface ExifBuildOptions {
	littleEndian?: boolean;
	dateTimeOriginal?: string | null;
	latRef?: string;
	lonRef?: string;
	/** 緯度の度分秒の分子/分母(分母0の異常系用)。既定は35°39'30" */
	latDms?: [[number, number], [number, number], [number, number]];
	lonDms?: [[number, number], [number, number], [number, number]];
	omitGps?: boolean;
}

function buildTiff(options: ExifBuildOptions = {}): Uint8Array {
	const {
		littleEndian = true,
		dateTimeOriginal = "2024:05:06 12:34:56",
		latRef = "N",
		lonRef = "E",
		latDms = [
			[35, 1],
			[39, 1],
			[30, 1],
		],
		lonDms = [
			[139, 1],
			[41, 1],
			[30, 1],
		],
		omitGps = false,
	} = options;
	const out: number[] = [];
	const u16 = (v: number) => {
		out.push(littleEndian ? v & 0xff : (v >> 8) & 0xff);
		out.push(littleEndian ? (v >> 8) & 0xff : v & 0xff);
	};
	const u32 = (v: number) => {
		const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
		if (littleEndian) b.reverse();
		out.push(...b);
	};
	const ascii = (s: string) => {
		for (const c of s) out.push(c.charCodeAt(0));
	};
	const patchU32 = (at: number, v: number) => {
		const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
		if (littleEndian) b.reverse();
		for (let i = 0; i < 4; i++) out[at + i] = b[i] as number;
	};

	// TIFFヘッダ
	ascii(littleEndian ? "II" : "MM");
	u16(42);
	u32(8);
	// IFD0(Exif + GPS の2エントリ)
	u16(omitGps ? 1 : 2);
	u16(0x8769);
	u16(4);
	u32(1);
	const exifOffPos = out.length;
	u32(0);
	if (!omitGps) {
		u16(0x8825);
		u16(4);
		u32(1);
	}
	const gpsOffPos = omitGps ? -1 : out.length;
	if (!omitGps) u32(0);
	u32(0); // next IFD

	// ExifIFD
	patchU32(exifOffPos, out.length);
	if (dateTimeOriginal === null) {
		u16(0);
	} else {
		u16(1);
		u16(0x9003);
		u16(2);
		u32(dateTimeOriginal.length + 1);
		const strOffPos = out.length;
		u32(0);
		u32(0); // next IFD
		patchU32(strOffPos, out.length);
		ascii(dateTimeOriginal);
		out.push(0);
	}

	// GPS IFD
	if (!omitGps) {
		patchU32(gpsOffPos, out.length);
		u16(4);
		// 緯度Ref(2文字なのでインライン)
		u16(0x0001);
		u16(2);
		u32(2);
		const latRefPos = out.length;
		u32(0);
		// 緯度
		u16(0x0002);
		u16(5);
		u32(3);
		const latOffPos = out.length;
		u32(0);
		// 経度Ref
		u16(0x0003);
		u16(2);
		u32(2);
		const lonRefPos = out.length;
		u32(0);
		// 経度
		u16(0x0004);
		u16(5);
		u32(3);
		const lonOffPos = out.length;
		u32(0);
		u32(0); // next IFD
		// インライン値の書き込み(残り2バイトは0のまま)
		out[latRefPos] = latRef.charCodeAt(0);
		out[latRefPos + 1] = 0;
		out[lonRefPos] = lonRef.charCodeAt(0);
		out[lonRefPos + 1] = 0;
		// 有理数列
		patchU32(latOffPos, out.length);
		for (const [num, den] of latDms) {
			u32(num);
			u32(den);
		}
		patchU32(lonOffPos, out.length);
		for (const [num, den] of lonDms) {
			u32(num);
			u32(den);
		}
	}
	return new Uint8Array(out);
}

function buildJpeg(tiff: Uint8Array, prefixSegments: Uint8Array[] = []): Uint8Array {
	const parts: number[] = [0xff, 0xd8];
	for (const seg of prefixSegments) parts.push(...seg);
	// APP1 Exif
	const len = tiff.length + 8;
	parts.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff);
	for (const c of "Exif") parts.push(c.charCodeAt(0));
	parts.push(0, 0);
	parts.push(...tiff);
	// EOI
	parts.push(0xff, 0xd9);
	return new Uint8Array(parts);
}

/** XMPのようなExifでないAPP1(スキップされるべきもの)。 */
function xmpSegment(): Uint8Array {
	const body = [0x68, 0x74, 0x74, 0x70]; // "http..."
	const len = body.length + 2;
	return new Uint8Array([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...body]);
}

function jpegFile(bytes: Uint8Array, type = "image/jpeg"): File {
	return new File([bytes as unknown as ArrayBuffer], "p.jpg", { type });
}

describe("parseExifFromBytes", () => {
	it("LEのDateTimeOriginalを暦日にしてGPSを十進度で返す", () => {
		const exif = parseExifFromBytes(buildJpeg(buildTiff()));
		expect(exif.takenOn).toBe("2024-05-06");
		expect(exif.gps?.latitude).toBeCloseTo(35 + 39 / 60 + 30 / 3600, 6);
		expect(exif.gps?.longitude).toBeCloseTo(139 + 41 / 60 + 30 / 3600, 6);
	});

	it("BEでも同じく読める", () => {
		const exif = parseExifFromBytes(
			buildJpeg(buildTiff({ littleEndian: false })),
		);
		expect(exif.takenOn).toBe("2024-05-06");
		expect(exif.gps?.latitude).toBeCloseTo(35 + 39 / 60 + 30 / 3600, 6);
	});

	it("南緯・西経は負になる", () => {
		const exif = parseExifFromBytes(
			buildJpeg(buildTiff({ latRef: "S", lonRef: "W" })),
		);
		expect(exif.gps?.latitude).toBeLessThan(0);
		expect(exif.gps?.longitude).toBeLessThan(0);
	});

	it("DateTimeOriginalが無ければ日時はnull(GPSは読める)", () => {
		const exif = parseExifFromBytes(
			buildJpeg(buildTiff({ dateTimeOriginal: null })),
		);
		expect(exif.takenOn).toBeNull();
		expect(exif.gps).not.toBeNull();
	});

	it("実在しない日付は捨てる", () => {
		const exif = parseExifFromBytes(
			buildJpeg(buildTiff({ dateTimeOriginal: "2024:02:31 12:00:00" })),
		);
		expect(exif.takenOn).toBeNull();
	});

	it("分母0のGPSは捨てる(0除算しない)", () => {
		const exif = parseExifFromBytes(
			buildJpeg(
				buildTiff({
					latDms: [
						[35, 1],
						[39, 0],
						[30, 1],
					],
				}),
			),
		);
		expect(exif.gps).toBeNull();
		expect(exif.takenOn).toBe("2024-05-06");
	});

	it("ExifでないAPP1を飛ばして後のExifを読む", () => {
		const exif = parseExifFromBytes(buildJpeg(buildTiff(), [xmpSegment()]));
		expect(exif.takenOn).toBe("2024-05-06");
	});

	it("EXIFなしJPEGはnull埋め", () => {
		// SOI + APP0(JFIF) + EOI
		const bytes = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
			0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
		]);
		expect(parseExifFromBytes(bytes)).toEqual({
			takenOn: null,
			gps: null,
		});
	});

	it("JPEG以外・壊れた入力はthrowせずnull埋め", () => {
		// PNGシグネチャ
		expect(
			parseExifFromBytes(
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			),
		).toEqual({ takenOn: null, gps: null });
		expect(parseExifFromBytes(new Uint8Array([]))).toEqual({
			takenOn: null,
			gps: null,
		});
		// SOIだけで切れている
		expect(parseExifFromBytes(new Uint8Array([0xff, 0xd8]))).toEqual({
			takenOn: null,
			gps: null,
		});
		// APP1の長さだけあって実体が無い
		expect(
			parseExifFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20])),
		).toEqual({ takenOn: null, gps: null });
	});
});

describe("exifDateTimeToCalendarDate", () => {
	it("EXIF日時→暦日", () => {
		expect(exifDateTimeToCalendarDate("2024:05:06 12:34:56")).toBe("2024-05-06");
	});
	it("形式違い・範囲外はnull", () => {
		expect(exifDateTimeToCalendarDate("2024-05-06")).toBeNull();
		expect(exifDateTimeToCalendarDate("2024:02:31 00:00:00")).toBeNull();
		expect(exifDateTimeToCalendarDate("1899:05:06 00:00:00")).toBeNull();
		expect(exifDateTimeToCalendarDate("")).toBeNull();
	});
});

describe("readPhotoExif / firstTakenOn", () => {
	it("Fileから読める", async () => {
		const exif = await readPhotoExif(jpegFile(buildJpeg(buildTiff())));
		expect(exif.takenOn).toBe("2024-05-06");
	});

	it("JPEG以外は読まずに飛ばし、最初のEXIF日時を返す", async () => {
		const png = new File([new Uint8Array([1, 2, 3])], "a.png", {
			type: "image/png",
		});
		const noExif = jpegFile(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
		const withExif = jpegFile(buildJpeg(buildTiff()));
		await expect(firstTakenOn([png, noExif, withExif])).resolves.toBe(
			"2024-05-06",
		);
	});

	it("全滅時はnull", async () => {
		await expect(firstTakenOn([])).resolves.toBeNull();
		const png = new File([new Uint8Array([1])], "a.png", {
			type: "image/png",
		});
		await expect(firstTakenOn([png])).resolves.toBeNull();
	});
});
