import { isCalendarDate } from "#/lib/date/calendar-date";

// 写真のEXIFから撮影日・GPSを読む(Issue #590)。ブラウザ側で動かす既存の
// photo-resize / photo-picker と同層に置く——Workersランタイムではなく
// 写真の選択時に読む。依存は足さない。許可形式(JPEG/PNG/WebP/GIF)のうち
// EXIFを持つのは実質JPEGだけで、自前の数十行で読めるためバンドルは増えない
// (AGENTS.mdのmaplibre教訓: 依存追加時はバンドル影響を確認する)。

/** EXIFのGPS座標(十進度)。 */
export interface PhotoGps {
	latitude: number;
	longitude: number;
}

export interface PhotoExif {
	/** 撮影日 "YYYY-MM-DD"(DateTimeOriginal の日付部)。無い・壊れている場合は null */
	takenOn: string | null;
	/**
	 * GPS座標。場所マスタに座標列が無く逆ジオコーディングも範囲外のため、
	 * このPRでは日時だけを自動入力に使い、GPSは将来のランドマーク特定用に
	 * パースだけして返す(場所への反映はしない。方針はIssue #590に記録)。
	 */
	gps: PhotoGps | null;
}

const NO_EXIF: PhotoExif = { takenOn: null, gps: null };

// ---- JPEG走査 ------------------------------------------------------------
// SOI の後、SOS/EOI より前に現れる `Exif\0\0` ヘッダ付きAPP1だけを読む。
// XMP等の別APP1・他セグメントは長さで飛ばす。壊れていたら黙って null へ
// (EXIFなし・取得失敗時は従来通りのフォールバックが必須なため、throwしない)。

function findExifTiff(bytes: Uint8Array): { view: DataView; start: number } | null {
	if (bytes.length < 4) return null;
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;
	let pos = 2;
	while (pos + 2 <= view.byteLength) {
		if (view.getUint8(pos) !== 0xff) return null;
		let marker = view.getUint8(pos + 1);
		pos += 2;
		// フィルバイト(0xFFの連続)を飛ばす
		while (marker === 0xff && pos < view.byteLength) {
			marker = view.getUint8(pos);
			pos += 1;
		}
		// EOI / SOS より後にEXIFは現れない
		if (marker === 0xd9 || marker === 0xda) return null;
		// 長さを持たないマーカー(TEM / RSTn)
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
		if (pos + 2 > view.byteLength) return null;
		const segLen = view.getUint16(pos);
		if (segLen < 2 || pos + segLen > view.byteLength) return null;
		if (
			marker === 0xe1 &&
			segLen >= 8 &&
			view.getUint8(pos + 2) === 0x45 && // E
			view.getUint8(pos + 3) === 0x78 && // x
			view.getUint8(pos + 4) === 0x69 && // i
			view.getUint8(pos + 5) === 0x66 && // f
			view.getUint8(pos + 6) === 0x00 &&
			view.getUint8(pos + 7) === 0x00
		) {
			return { view, start: pos + 8 };
		}
		pos += segLen;
	}
	return null;
}

// ---- TIFF読み ------------------------------------------------------------
// 範囲外アクセスは undefined へ潰す。DataViewは範囲外でthrowするため、
// 呼び出し側は戻り値を見て黙って null へ倒す(フォールバック必須)。

const TYPE_SIZES: Record<number, number> = {
	1: 1, // BYTE
	2: 1, // ASCII
	3: 2, // SHORT
	4: 4, // LONG
	5: 8, // RATIONAL
};

interface Tiff {
	view: DataView;
	start: number;
	end: number;
	littleEndian: boolean;
	u16: (offset: number) => number | undefined;
	u32: (offset: number) => number | undefined;
}

function openTiff(view: DataView, start: number): Tiff | null {
	const end = view.byteLength;
	if (start + 8 > end) return null;
	const b0 = view.getUint8(start);
	const b1 = view.getUint8(start + 1);
	const littleEndian = b0 === 0x49 && b1 === 0x49; // "II"
	const bigEndian = b0 === 0x4d && b1 === 0x4d; // "MM"
	if (!littleEndian && !bigEndian) return null;
	const le = littleEndian;
	const u16 = (offset: number): number | undefined =>
		offset >= start && offset + 2 <= end
			? view.getUint16(offset, le)
			: undefined;
	const u32 = (offset: number): number | undefined =>
		offset >= start && offset + 4 <= end
			? view.getUint32(offset, le)
			: undefined;
	if (u16(start + 2) !== 42) return null;
	const ifd0offset = u32(start + 4);
	if (ifd0offset === undefined) return null;
	const ifd0 = start + ifd0offset;
	if (ifd0 < start + 8 || ifd0 + 2 > end) return null;
	return { view, start, end, littleEndian: le, u16, u32 };
}

/** IFD内のタグを探し、生の値フィールド(オフセット位置)を返す。 */
function findTag(
	tiff: Tiff,
	ifd: number,
	tag: number,
): { type: number; count: number; valueAt: number } | null {
	if (ifd < tiff.start || ifd + 2 > tiff.end) return null;
	const n = tiff.u16(ifd);
	if (n === undefined || n > 512) return null;
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		if (e + 12 > tiff.end) return null;
		if (tiff.u16(e) !== tag) continue;
		const type = tiff.u16(e + 2);
		const count = tiff.u32(e + 4);
		if (type === undefined || count === undefined) return null;
		return { type, count, valueAt: e + 8 };
	}
	return null;
}

/** ASCIIタグを読む。NUL終端までを返す(異常時は null)。 */
function readAscii(tiff: Tiff, ifd: number, tag: number): string | null {
	const found = findTag(tiff, ifd, tag);
	if (!found || found.type !== 2 || found.count < 1 || found.count > 256) {
		return null;
	}
	const size = found.count;
	let at: number;
	if (size <= 4) {
		at = found.valueAt;
	} else {
		const offset = tiff.u32(found.valueAt);
		if (offset === undefined) return null;
		at = tiff.start + offset;
	}
	if (at < tiff.start || at + size > tiff.end) return null;
	let out = "";
	for (let i = 0; i < size; i++) {
		const c = tiff.view.getUint8(at + i);
		if (c === 0) break;
		// ASCIIのはずなので127超は壊れているとみなす
		if (c > 127) return null;
		out += String.fromCharCode(c);
	}
	return out;
}

/** LONG×1タグを読む(Exif/GPSのIFDオフセット用)。 */
function readU32(tiff: Tiff, ifd: number, tag: number): number | null {
	const found = findTag(tiff, ifd, tag);
	if (!found || found.type !== 4 || found.count !== 1) return null;
	return tiff.u32(found.valueAt) ?? null;
}

/** RATIONAL×3タグを十進度へ(異常時は null)。分母0は0として扱わず全体を捨てる。 */
function readDegreeTriple(
	tiff: Tiff,
	ifd: number,
	tag: number,
): number | null {
	const found = findTag(tiff, ifd, tag);
	if (!found || found.type !== 5 || found.count !== 3) return null;
	const offset = tiff.u32(found.valueAt);
	if (offset === undefined) return null;
	const at = tiff.start + offset;
	if (at < tiff.start || at + 24 > tiff.end) return null;
	const parts: number[] = [];
	for (let i = 0; i < 3; i++) {
		const num = tiff.u32(at + i * 8);
		const den = tiff.u32(at + i * 8 + 4);
		if (num === undefined || den === undefined || den === 0) return null;
		parts.push(num / den);
	}
	const [d, m, s] = parts as [number, number, number];
	return d + m / 60 + s / 3600;
}

/** "YYYY:MM:DD HH:MM:SS" → "YYYY-MM-DD"。形式違い・実在しない日は null。 */
export function exifDateTimeToCalendarDate(value: string): string | null {
	const m = /^(\d{4}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}$/.exec(value);
	if (!m) return null;
	const date = `${m[1]}-${m[2]}-${m[3]}`;
	return isCalendarDate(date) ? date : null;
}

/**
 * バイト列からEXIFをパースする純関数。JPEG以外・EXIFなし・壊れたEXIFは
 * いずれも `{ takenOn: null, gps: null }` を返す(throwしない)。
 */
export function parseExifFromBytes(bytes: Uint8Array): PhotoExif {
	try {
		const found = findExifTiff(bytes);
		if (!found) return NO_EXIF;
		const tiff = openTiff(found.view, found.start);
		if (!tiff) return NO_EXIF;
		const ifd0offset = tiff.u32(tiff.start + 4);
		if (ifd0offset === undefined) return NO_EXIF;
		const ifd0 = tiff.start + ifd0offset;

		let takenOn: string | null = null;
		const exifOffset = readU32(tiff, ifd0, 0x8769);
		if (exifOffset !== null) {
			const exifIfd = tiff.start + exifOffset;
			const raw = readAscii(tiff, exifIfd, 0x9003);
			takenOn = raw ? (exifDateTimeToCalendarDate(raw) ?? null) : null;
		}

		let gps: PhotoGps | null = null;
		const gpsOffset = readU32(tiff, ifd0, 0x8825);
		if (gpsOffset !== null) {
			const gpsIfd = tiff.start + gpsOffset;
			const latRef = readAscii(tiff, gpsIfd, 0x0001);
			const lonRef = readAscii(tiff, gpsIfd, 0x0003);
			const lat = readDegreeTriple(tiff, gpsIfd, 0x0002);
			const lon = readDegreeTriple(tiff, gpsIfd, 0x0004);
			if (
				lat !== null &&
				lon !== null &&
				(latRef === "N" || latRef === "S") &&
				(lonRef === "E" || lonRef === "W")
			) {
				const latitude = latRef === "S" ? -lat : lat;
				const longitude = lonRef === "W" ? -lon : lon;
				if (
					Number.isFinite(latitude) &&
					Number.isFinite(longitude) &&
					Math.abs(latitude) <= 90 &&
					Math.abs(longitude) <= 180
				) {
					gps = { latitude, longitude };
				}
			}
		}
		return { takenOn, gps };
	} catch {
		return NO_EXIF;
	}
}

/**
 * 1ファイルからEXIFを読む。デコード失敗時も null 埋めで返す(throwしない)。
 */
export async function readPhotoExif(file: Blob): Promise<PhotoExif> {
	try {
		const buffer = await file.arrayBuffer();
		return parseExifFromBytes(new Uint8Array(buffer));
	} catch {
		return NO_EXIF;
	}
}

/**
 * 複数ファイルのうち最初に見つかった撮影日を返す。EXIFのない写真は飛ばす。
 * 失敗時・全滅時は null(呼び出し側は従来通りの既定値のままにする)。
 *
 * JPEG以外(PNG/WebP/GIF)はEXIFを持たないので読まずに飛ばす。`type` が空の
 * File(Androidの一部経路)だけは中身を見ないと分からないので読む。
 */
export async function firstTakenOn(
	files: readonly Blob[],
): Promise<string | null> {
	for (const file of files) {
		const type = (file as File).type ?? "";
		if (type !== "" && type !== "image/jpeg") continue;
		const exif = await readPhotoExif(file);
		if (exif.takenOn) return exif.takenOn;
	}
	return null;
}
