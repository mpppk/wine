// ワイン写真の共通制約とR2キー生成。Webのアップロードルートと
// MCPツール(base64受け取り)の両方から使う純関数群。

export const ALLOWED_PHOTO_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const PHOTO_EXT_MAP: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

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

/** R2キー。entryIdはUUIDなのでURLの推測不能性はここに依存する */
export function buildWinePhotoKey(
	userId: string,
	entryId: string,
	mimeType: string,
): string {
	const ext = PHOTO_EXT_MAP[mimeType];
	if (!ext) throw new Error(`Unsupported image type: ${mimeType}`);
	return `wines/${userId}/${entryId}.${ext}`;
}
