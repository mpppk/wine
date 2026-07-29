// 画像をブラウザ側で縮小する共通ヘルパー。用途は2つあり、どちらも「送る前に小さくする」:
//  - エチケット解析(AI入力トークン=クレジットと転送量の削減)
//  - 一覧用サムネイルの生成(#237。表示150〜200pxに原寸5MBを読ませない)
// 保存用のオリジナル写真そのものは縮小しない。

/**
 * 画像を長辺 maxDimension px 以下のJPEGに縮小する。
 * デコードや変換に失敗した場合は元ファイルのまま返す(呼び出し側は原寸で続行できる)。
 */
export async function downscaleImage(
	file: Blob,
	{
		maxDimension,
		quality,
		/** 縮小不要(既に小さいJPEG)でも必ずJPEGを作り直すか。サムネイル生成は false でよい。 */
		forceReencode = false,
	}: { maxDimension: number; quality: number; forceReencode?: boolean },
): Promise<Blob> {
	try {
		// EXIFの回転をブラウザに解決させてからキャンバスへ描く
		const bitmap = await createImageBitmap(file, {
			imageOrientation: "from-image",
		});
		try {
			const scale = Math.min(
				1,
				maxDimension / Math.max(bitmap.width, bitmap.height),
			);
			if (scale >= 1 && file.type === "image/jpeg" && !forceReencode) {
				return file;
			}
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return file;
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/jpeg", quality),
			);
			return blob ?? file;
		} finally {
			bitmap.close();
		}
	} catch {
		return file;
	}
}
