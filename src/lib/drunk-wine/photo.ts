// ワイン写真の共通制約とR2キー生成。Webのアップロードルートと
// MCPツール(base64受け取り)の両方から使う純関数群。

import { BadRequestError } from "#/lib/errors";

// 許可MIMEの単一情報源。拡張子・Set・accept属性・画面に出す形式名はすべてここから
// 導出する。形式を足すときはこの1箇所だけを直せば、入力欄の accept も説明文の
// 「JPEG・PNG・WebP・GIF」も追随する
// (src/lib/mcp/schemas.ts の z.enum はリテラルが必要なため手書きだが、
// 変更時はここと同期すること)。
const PHOTO_FORMATS = {
	"image/jpeg": { ext: "jpg", label: "JPEG" },
	"image/png": { ext: "png", label: "PNG" },
	"image/webp": { ext: "webp", label: "WebP" },
	"image/gif": { ext: "gif", label: "GIF" },
} as const;

const PHOTO_EXT_MAP: Record<string, string> = Object.fromEntries(
	Object.entries(PHOTO_FORMATS).map(([mime, f]) => [mime, f.ext]),
);

export const ALLOWED_PHOTO_TYPES = new Set(Object.keys(PHOTO_EXT_MAP));

/** <input type="file" accept=...> 用 */
export const PHOTO_ACCEPT_ATTR = Object.keys(PHOTO_EXT_MAP).join(",");

/** 説明文に出す許可形式の並び(例: 「JPEG・PNG・WebP・GIF」)。 */
export const PHOTO_FORMATS_LABEL_JA = Object.values(PHOTO_FORMATS)
	.map((f) => f.label)
	.join("・");

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** 説明文・エラー文言に出す上限サイズ(例: 「5MB」)。 */
export const MAX_PHOTO_SIZE_LABEL = `${MAX_PHOTO_BYTES / 1024 / 1024}MB`;

/** 1エントリに添付できる写真の最大枚数(AI解析の入力トークン=クレジットの上限も兼ねる)。 */
export const MAX_PHOTOS_PER_ENTRY = 6;

/**
 * FormData 全体のバイト数上限。全枚数ぶん + multipart 境界等のオーバーヘッドを見込む。
 *
 * **サーバ(images/form-api.ts の前チェック)とクライアント(images/form-client.ts の
 * 送信前ガード)の双方が同じ式を使う**。片方だけ持つと、サーバが 413 で弾くサイズを
 * クライアントが送信してしまい、モバイル回線では 413 が返る前に接続が切れて
 * 「Failed to fetch」になる(レスポンスが無いのでエラー文言も出せない)。
 */
export function maxFormDataBytes(
	maxPhotos: number = MAX_PHOTOS_PER_ENTRY,
): number {
	return MAX_PHOTO_BYTES * maxPhotos + 64 * 1024;
}

/**
 * MIMEタイプに対応する拡張子を返す。未対応は undefined。
 * PHOTO_EXT_MAP は plain object なので、外部入力の mimeType が constructor /
 * __proto__ / toString 等の継承プロパティに解決して truthy 値をすり抜けないよう、
 * 自前プロパティかつ string 値であることを検証する(許可MIMEの単一情報源)。
 */
export function photoExtForMime(mimeType: string): string | undefined {
	if (!Object.hasOwn(PHOTO_EXT_MAP, mimeType)) return undefined;
	const ext = PHOTO_EXT_MAP[mimeType];
	return typeof ext === "string" ? ext : undefined;
}

/**
 * 先頭バイト(マジックナンバー)から実フォーマットのMIMEを判定する。判定できなければ
 * undefined。クライアント申告の Content-Type を信用せず、保存・配信する Content-Type を
 * サーバ側で確定するために使う(中身がHTML/スクリプトの画像偽装を弾く多層防御)。
 * 対応は許可4種(JPEG/PNG/WebP/GIF)のみ。
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
	// JPEG: FF D8 FF
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	// GIF: "GIF87a" / "GIF89a"
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}
	// WebP: "RIFF"????"WEBP"
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

/**
 * 申告MIMEの非標準エイリアスの正規化(#593)。`image/jpg` は標準登録されていないが
 * JPEGの慣用表記として実在し、VivinoのCDNのように返すサイトがある。ブラウザの
 * `<img>` は表示できるため、レビューカードではWeb画像が出るのにサーバ側の関門
 * (`resolveStoredPhotoMime`)で弾かれて「分析では出たのに登録後に消えた」になる。
 * 正規化はこの1箇所に閉じ込め、`ALLOWED_PHOTO_TYPES` のSSOTは変えない。
 */
function normalizeDeclaredPhotoMime(declaredMime: string): string {
	return declaredMime === "image/jpg" ? "image/jpeg" : declaredMime;
}

/**
 * 保存する写真の Content-Type を実バイト(マジックバイト)から確定する多層防御。
 * 申告 mimeType が許可外、実バイトが画像として判定できない、または申告と実フォーマットが
 * 食い違う場合は undefined を返す(呼び出し側で拒否する)。保存する contentType・拡張子は
 * 申告値ではなくここが返す実MIMEを使うことで、中身がHTML/スクリプト等の画像偽装を弾く。
 *
 * **画像を保存する全経路がこの1関数を通る**(#150 でワイン写真へ、#260 でアバターへ適用)。
 * 以前はアバター経路(api/upload.ts)だけが sniff 結果を無条件採用しており、「申告 png・実体
 * jpeg」がアバターでは通りワイン写真では弾かれるという非対称があった。厳しい側(申告と実体の
 * 一致を要求)へ揃えてある。検証を強化するときはここだけを直せば全経路に効く。
 */
export function resolveStoredPhotoMime(
	bytes: Uint8Array,
	declaredMime: string,
): string | undefined {
	const declared = normalizeDeclaredPhotoMime(declaredMime);
	if (!ALLOWED_PHOTO_TYPES.has(declared)) return undefined;
	const sniffed = sniffImageMime(bytes);
	// 実フォーマットを判定できない、または申告と食い違う場合は拒否する(申告値は信用しない)
	if (!sniffed || sniffed !== declared) return undefined;
	return sniffed;
}

// ---- 画像メタデータの除去 (#641) --------------------------------------------
// アバターは無認証の公開配信なので、GPS等のEXIFをサーバ側で必ず落とす。
// クライアント側の再エンコードだけに頼らない(直接APIを叩く経路がある)。
//
// 第一経路は IMAGES バインディングでの再エンコード(src/lib/images/sanitize.ts)で、
// ここは「それが無い環境(dev等)のフォールバック」と「ワイン写真(非公開・原寸の
// 画質を保ちたい)の除去」に使う**可逆な除去**。画像データ本体(JPEGのSOS以降・
// PNGのIDAT等)には触らず、メタデータのセグメント/チャンクだけを落とす。構造が
// 読めない入力は無加工で返す(壊れた画像をさらに壊さない)。
//
// JPEG の EXIF回転(Orientation)だけは例外で、2〜8なら向きだけを残した最小APP1に
// 建て替える。向きまで落とすと縦向きの写真が横倒しで表示される(ブラウザはEXIFの
// 向きを適用して描くため)。GPS・日時・端末情報は残らない。

/** 複数のバイト列をつなげる。 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

interface JpegSegment {
	marker: number;
	start: number;
	end: number;
}

/** バイト列の数値読みに使う DataView。subarray のビューにも対応する。 */
function viewOf(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * SOI直後からSOS/EOI手前までのセグメント列を辿る。SOS/EOIに着いたら、そこから
 * 末尾まで(エントロピーデータ・EOI)を無加工で残す起点と一緒に返す。壊れていたら
 * null(呼び出し側は無加工で返す)。
 */
function walkJpegSegments(
	bytes: Uint8Array,
): { segments: JpegSegment[]; imageStart: number } | null {
	if (bytes.length < 2) return null;
	const view = viewOf(bytes);
	if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;
	const segments: JpegSegment[] = [];
	let pos = 2;
	while (pos + 1 < bytes.length) {
		if (view.getUint8(pos) !== 0xff) return null;
		const marker = view.getUint8(pos + 1);
		if (marker === 0xff) {
			pos += 1; // フィルバイト
			continue;
		}
		// SOS/EOI以降は画像データなので解釈せず丸ごと残す
		if (marker === 0xd9 || marker === 0xda) {
			return { segments, imageStart: pos };
		}
		// 長さを持たないマーカー(TEM / RSTn)
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			segments.push({ marker, start: pos, end: pos + 2 });
			pos += 2;
			continue;
		}
		if (pos + 3 >= bytes.length) return null;
		const segLen = view.getUint16(pos + 2);
		if (segLen < 2 || pos + 2 + segLen > bytes.length) return null;
		segments.push({ marker, start: pos, end: pos + 2 + segLen });
		pos += 2 + segLen;
	}
	return null;
}

/**
 * APP1のExifボディからOrientationタグ値(1〜8)を読む。ExifでないAPP1(XMP等)・
 * Orientationが無い・壊れている場合は null。
 */
function readExifOrientationTag(body: Uint8Array): number | null {
	if (body.length < 6) return null;
	const head = viewOf(body);
	if (
		head.getUint8(0) !== 0x45 || // E
		head.getUint8(1) !== 0x78 || // x
		head.getUint8(2) !== 0x69 || // i
		head.getUint8(3) !== 0x66 || // f
		head.getUint8(4) !== 0x00 ||
		head.getUint8(5) !== 0x00
	) {
		return null;
	}
	const tiff = body.subarray(6);
	if (tiff.length < 8) return null;
	const view = viewOf(tiff);
	const le = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
	const be = view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d;
	if (!le && !be) return null;
	const u16 = (at: number): number | undefined =>
		at + 2 <= tiff.length ? view.getUint16(at, le) : undefined;
	const u32 = (at: number): number | undefined =>
		at + 4 <= tiff.length ? view.getUint32(at, le) : undefined;
	if (u16(2) !== 42) return null;
	const ifd0offset = u32(4);
	if (ifd0offset === undefined) return null;
	const ifd0 = ifd0offset;
	if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
	const n = u16(ifd0);
	if (n === undefined || n > 64) return null;
	for (let i = 0; i < n; i++) {
		const e = ifd0 + 2 + i * 12;
		if (e + 12 > tiff.length) return null;
		if (u16(e) !== 0x0112) continue;
		if (u16(e + 2) !== 3) return null; // SHORT以外は想定外
		if (u32(e + 4) !== 1) return null;
		const value = u16(e + 8); // count×2バイトなのでインライン
		if (value === undefined || value < 1 || value > 8) return null;
		return value;
	}
	return null;
}

/**
 * JPEG内の最初のExif APP1からOrientationタグ値(1〜8)を読む。無い・壊れている
 * 場合は null。向きの保持(最小APP1への建て替え要否)の判定に使う。
 */
export function readJpegOrientation(bytes: Uint8Array): number | null {
	const walked = walkJpegSegments(bytes);
	if (!walked) return null;
	for (const seg of walked.segments) {
		if (seg.marker !== 0xe1) continue;
		const value = readExifOrientationTag(
			bytes.subarray(seg.start + 4, seg.end),
		);
		if (value !== null) return value;
	}
	return null;
}

/** 向きだけを残した最小のAPP1 Exif(TIFFは常にLEで建てる)。 */
function buildMinimalExifApp1(orientation: number): Uint8Array {
	const body = new Uint8Array([
		0x45,
		0x78,
		0x69,
		0x66,
		0x00,
		0x00, // "Exif\0\0"
		0x49,
		0x49,
		0x2a,
		0x00,
		0x08,
		0x00,
		0x00,
		0x00, // TIFF LE, 42, IFD0@8
		0x01,
		0x00, // 1 entry
		0x12,
		0x01,
		0x03,
		0x00,
		0x01,
		0x00,
		0x00,
		0x00, // tag 0x0112 SHORT×1
		orientation & 0xff,
		(orientation >> 8) & 0xff,
		0x00,
		0x00, // value inline
		0x00,
		0x00,
		0x00,
		0x00, // next IFD
	]);
	const len = body.length + 2;
	return Uint8Array.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...body]);
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
	const walked = walkJpegSegments(bytes);
	if (!walked) return bytes;
	const orientation = readJpegOrientation(bytes);
	const parts: Uint8Array[] = [bytes.subarray(0, 2)];
	let dropped = false;
	for (const seg of walked.segments) {
		const m = seg.marker;
		// APP0(JFIF)・APP2(ICC等)・APP14(Adobe)は色の再現に要るので残す。
		// APP1(Exif/XMP)・APP13(Photoshop/IPTC)・COM・その他のAPPnは落とす。
		if (
			m === 0xe1 ||
			m === 0xed ||
			m === 0xfe ||
			(m >= 0xe0 && m <= 0xef && m !== 0xe0 && m !== 0xe2 && m !== 0xee)
		) {
			dropped = true;
			continue;
		}
		parts.push(bytes.subarray(seg.start, seg.end));
	}
	if (!dropped) return bytes;
	// 向きが1以外なら向きだけ残す(向きのAPP1は上で落とし済み)
	if (orientation !== null && orientation !== 1) {
		parts.push(buildMinimalExifApp1(orientation));
	}
	parts.push(bytes.subarray(walked.imageStart));
	return concatBytes(parts);
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 8) return bytes;
	const head = viewOf(bytes);
	for (let i = 0; i < 8; i++) {
		if (head.getUint8(i) !== sig[i]) return bytes;
	}
	// 落とすのは所在・作者・撮影日時の入るチャンクだけ。本文(IDAT等)・透過(tRNS)・
	// 色(sRGB/gAMA/cHRM/iCCP)・アニメ(acTL/fcTL/fdAT)は残す。
	const DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
	const parts: Uint8Array[] = [bytes.subarray(0, 8)];
	let pos = 8;
	let dropped = false;
	let seenIend = false;
	while (pos + 8 <= bytes.length) {
		const len = head.getUint32(pos);
		const type = String.fromCharCode(
			head.getUint8(pos + 4),
			head.getUint8(pos + 5),
			head.getUint8(pos + 6),
			head.getUint8(pos + 7),
		);
		if (pos + 12 + len > bytes.length) return bytes;
		if (DROP.has(type)) {
			dropped = true;
		} else {
			parts.push(bytes.subarray(pos, pos + 12 + len));
		}
		pos += 12 + len;
		if (type === "IEND") {
			seenIend = true;
			break;
		}
	}
	// IENDまで辿り着かない・IENDの後にゴミがある入力は触らない
	if (!seenIend || pos !== bytes.length) return bytes;
	if (!dropped) return bytes;
	return concatBytes(parts);
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 12) return bytes;
	const head = viewOf(bytes);
	if (
		head.getUint8(0) !== 0x52 || // R
		head.getUint8(1) !== 0x49 || // I
		head.getUint8(2) !== 0x46 || // F
		head.getUint8(3) !== 0x46 || // F
		head.getUint8(8) !== 0x57 || // W
		head.getUint8(9) !== 0x45 || // E
		head.getUint8(10) !== 0x42 || // B
		head.getUint8(11) !== 0x50 // P
	) {
		return bytes;
	}
	const header = bytes.slice(0, 12);
	const parts: Uint8Array[] = [header];
	const view = viewOf(bytes);
	let pos = 12;
	let droppedExif = false;
	let droppedXmp = false;
	let vp8x: Uint8Array | null = null;
	while (pos + 8 <= bytes.length) {
		const fourcc = String.fromCharCode(
			view.getUint8(pos),
			view.getUint8(pos + 1),
			view.getUint8(pos + 2),
			view.getUint8(pos + 3),
		);
		const size = view.getUint32(pos + 4, true);
		const end = pos + 8 + size + (size % 2);
		if (end > bytes.length) return bytes;
		if (fourcc === "EXIF") {
			droppedExif = true;
		} else if (fourcc === "XMP ") {
			droppedXmp = true;
		} else if (fourcc === "VP8X") {
			// フラグ(VP8Xペイロード先頭)を後で直すためコピーして保持する
			vp8x = bytes.slice(pos, end);
			parts.push(vp8x);
		} else {
			parts.push(bytes.subarray(pos, end));
		}
		pos = end;
	}
	if (pos !== bytes.length) return bytes;
	if (!droppedExif && !droppedXmp) return bytes;
	// 削ったチャンクの存在ビット(VP8XのEXIF=0x08・XMP=0x04)を落とす
	if (vp8x && vp8x.length >= 9) {
		let flags = viewOf(vp8x).getUint8(8);
		if (droppedExif) flags &= ~0x08;
		if (droppedXmp) flags &= ~0x04;
		vp8x[8] = flags;
	}
	const out = concatBytes(parts);
	// RIFFサイズ(全体-8)を付け直す
	viewOf(out).setUint32(4, out.length - 8, true);
	return out;
}

/** GIFのサブブロック列(サイズ+データの繰り返し・0x00終端)の末尾。壊れていたら-1。 */
function skipGifSubBlocks(view: DataView, length: number, pos: number): number {
	let p = pos;
	for (;;) {
		if (p >= length) return -1;
		const n = view.getUint8(p);
		p += 1;
		if (n === 0) return p;
		p += n;
		if (p > length) return -1;
	}
}

/** GIFのApplication ExtensionがNETSCAPE2.0(アニメのループ指定)か。 */
function isNetscapeAppExt(
	view: DataView,
	dataStart: number,
	blockEnd: number,
): boolean {
	if (dataStart + 12 > blockEnd) return false;
	if (view.getUint8(dataStart) !== 0x0b) return false;
	const id = "NETSCAPE2.0";
	for (let i = 0; i < 11; i++) {
		if (view.getUint8(dataStart + 1 + i) !== id.charCodeAt(i)) return false;
	}
	return true;
}

function stripGifMetadata(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 13) return bytes;
	const view = viewOf(bytes);
	if (
		view.getUint8(0) !== 0x47 ||
		view.getUint8(1) !== 0x49 ||
		view.getUint8(2) !== 0x46
	) {
		return bytes;
	}
	let pos = 6 + 7;
	const packedLsd = view.getUint8(10);
	if (packedLsd & 0x80) {
		pos += 3 * (1 << ((packedLsd & 0x07) + 1));
	}
	if (pos > bytes.length) return bytes;
	const parts: Uint8Array[] = [bytes.subarray(0, pos)];
	let dropped = false;
	while (pos < bytes.length) {
		const sep = view.getUint8(pos);
		if (sep === 0x3b) {
			parts.push(bytes.subarray(pos, pos + 1));
			pos += 1;
			break;
		}
		if (sep === 0x21) {
			if (pos + 2 > bytes.length) return bytes;
			const label = view.getUint8(pos + 1);
			const blockEnd = skipGifSubBlocks(view, bytes.length, pos + 2);
			if (blockEnd < 0) return bytes;
			// コメント拡張は落とす。アプリケーション拡張はXMP(`XMP DataXMP`等)を
			// 落としつつ、アニメのループ指定(NETSCAPE2.0)だけ残す。
			if (label === 0xfe) {
				dropped = true;
			} else if (label === 0xff && !isNetscapeAppExt(view, pos + 2, blockEnd)) {
				dropped = true;
			} else {
				parts.push(bytes.subarray(pos, blockEnd));
			}
			pos = blockEnd;
			continue;
		}
		if (sep === 0x2c) {
			if (pos + 10 > bytes.length) return bytes;
			let p = pos + 10;
			const packedImg = view.getUint8(pos + 9);
			if (packedImg & 0x80) p += 3 * (1 << ((packedImg & 0x07) + 1));
			if (p >= bytes.length) return bytes;
			p += 1; // LZW最小コードサイズ
			const end = skipGifSubBlocks(view, bytes.length, p);
			if (end < 0) return bytes;
			parts.push(bytes.subarray(pos, end));
			pos = end;
			continue;
		}
		return bytes;
	}
	if (pos !== bytes.length) return bytes;
	if (!dropped) return bytes;
	return concatBytes(parts);
}

/**
 * 画像バイト列からメタデータ(GPS等のEXIF・XMP・コメント等)を取り除く。
 * 画像データ本体には触らない可逆な除去で、形式も変わらない。
 * 構造が読めない入力は無加工で返す(呼び出し側のMIME検証は別途行う)。
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
	switch (sniffImageMime(bytes)) {
		case "image/jpeg":
			return stripJpegMetadata(bytes);
		case "image/png":
			return stripPngMetadata(bytes);
		case "image/webp":
			return stripWebpMetadata(bytes);
		case "image/gif":
			return stripGifMetadata(bytes);
		default:
			return bytes;
	}
}

/**
 * base64文字列をバイト列にデコードする。MIME不正・base64不正・デコード後5MB超は
 * いずれもクライアント入力起因なので BadRequestError を投げる(#250)。素の Error だと
 * MCP・server fn の境界が「内部エラー」に丸めてしまい、送り直せば直る失敗だと伝わらない。
 */
export function decodePhotoBase64(
	base64: string,
	mimeType: string,
): Uint8Array {
	if (!ALLOWED_PHOTO_TYPES.has(mimeType)) {
		throw new BadRequestError(`Unsupported image type: ${mimeType}`);
	}
	// data URL で渡された場合はプレフィックスを剥がす
	const raw = base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
	let binary: string;
	try {
		binary = atob(raw);
	} catch {
		throw new BadRequestError("Invalid base64 image data");
	}
	if (binary.length > MAX_PHOTO_BYTES) {
		throw new BadRequestError("Image exceeds 5 MB limit");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---- サムネイル (#237) -----------------------------------------------------
// 一覧グリッドは150〜200pxで表示するのに原寸(最大5MB)を読んでいた。保存時に
// 縮小版を並べて置き、一覧はそちらを読む。サムネイルのキーは原寸キーから**導出**する
// (DBに別カラムを持たない)。導出にしておくと、既存写真のようにサムネイルが無い場合も
// 配信ルート側で原寸へフォールバックでき、移行のためのバックフィルが要らない。

/** サムネイルのキー接尾辞。常に JPEG で保存する。 */
const PHOTO_THUMB_SUFFIX = ".thumb.jpg";

/** サムネイルの長辺(px)。一覧の表示サイズ(最大200px程度)の2倍を上限にする。 */
export const PHOTO_THUMB_MAX_DIMENSION = 400;

/** サムネイル生成時のJPEG品質。 */
export const PHOTO_THUMB_JPEG_QUALITY = 0.8;

export function isPhotoThumbKey(key: string): boolean {
	return key.endsWith(PHOTO_THUMB_SUFFIX);
}

/** 原寸キー → サムネイルキー。 */
export function thumbKeyForPhotoKey(photoKey: string): string {
	return `${photoKey}${PHOTO_THUMB_SUFFIX}`;
}

/** サムネイルキー → 原寸キー。サムネイルキーでなければ null。 */
export function photoKeyForThumbKey(thumbKey: string): string | null {
	if (!isPhotoThumbKey(thumbKey)) return null;
	return thumbKey.slice(0, -PHOTO_THUMB_SUFFIX.length);
}

/**
 * 写真1枚ぶんのR2キー。entryId・photoId はいずれもUUIDで、URLの推測不能性は
 * ここに依存する。1エントリに複数枚持てるよう photoId でキーを一意化する。
 */
export function buildWinePhotoKey(
	userId: string,
	entryId: string,
	photoId: string,
	mimeType: string,
): string {
	const ext = photoExtForMime(mimeType);
	if (!ext) throw new Error(`Unsupported image type: ${mimeType}`);
	return `wines/${userId}/${entryId}/${photoId}.${ext}`;
}
