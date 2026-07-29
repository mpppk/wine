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

export const PHOTO_EXT_MAP: Record<string, string> = Object.fromEntries(
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
	if (!ALLOWED_PHOTO_TYPES.has(declaredMime)) return undefined;
	const sniffed = sniffImageMime(bytes);
	// 実フォーマットを判定できない、または申告と食い違う場合は拒否する(申告値は信用しない)
	if (!sniffed || sniffed !== declaredMime) return undefined;
	return sniffed;
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
export const PHOTO_THUMB_SUFFIX = ".thumb.jpg";

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
