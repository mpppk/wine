// ワイン写真の共通制約とR2キー生成。Webのアップロードルートと
// MCPツール(base64受け取り)の両方から使う純関数群。

// 許可MIMEの単一情報源。Set・accept属性はここから導出する
// (src/lib/mcp/schemas.ts の z.enum はリテラルが必要なため手書きだが、
// 変更時はここと同期すること)。
export const PHOTO_EXT_MAP: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

export const ALLOWED_PHOTO_TYPES = new Set(Object.keys(PHOTO_EXT_MAP));

/** <input type="file" accept=...> 用 */
export const PHOTO_ACCEPT_ATTR = Object.keys(PHOTO_EXT_MAP).join(",");

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

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
 * base64文字列をバイト列にデコードする。MIME不正・base64不正・
 * デコード後5MB超は Error を投げる(MCPツールがそのままエラー文言に使う)。
 */
export function decodePhotoBase64(
	base64: string,
	mimeType: string,
): Uint8Array {
	if (!ALLOWED_PHOTO_TYPES.has(mimeType)) {
		throw new Error(`Unsupported image type: ${mimeType}`);
	}
	// data URL で渡された場合はプレフィックスを剥がす
	const raw = base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
	let binary: string;
	try {
		binary = atob(raw);
	} catch {
		throw new Error("Invalid base64 image data");
	}
	if (binary.length > MAX_PHOTO_BYTES) {
		throw new Error("Image exceeds 5 MB limit");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
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
