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
