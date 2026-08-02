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

/**
 * 縮小に失敗した写真をそれでも送ってよい上限バイト数。
 *
 * 長辺1280〜1600px・品質0.85のJPEGは実測で概ね0.3〜0.7MBに収まる。これを大きく
 * 超えるのは縮小に失敗して原寸のまま送ろうとしている状態で、枚数ぶん積むと
 * アップロードが完了せず「Failed to fetch」になる。小さい写真ならデコードに
 * 失敗していても送信自体は成功するので、サーバのAIに判断させる。
 */
const ANALYSIS_UNRESIZED_MAX_BYTES = 1024 * 1024;

/** 縮小に失敗した大きな写真を送らずに落とすときの文言。 */
export function unresizablePhotoMessage(photoNumber: number): string {
	return `${photoNumber}枚目の写真をこの端末で縮小できませんでした。そのまま送ると通信が失敗するため、解像度の低い写真に差し替えるか、この写真を外して再試行してください。`;
}

/**
 * AI解析へ送るための縮小。**返る Blob は必ず送信可能な大きさである**ことを保証し、
 * 保証できない場合は理由の分かる Error を throw する(エチケット解析・一括抽出で共有)。
 *
 * `downscaleImage` は失敗時に原寸へ黙ってフォールバックする。サムネイル生成では
 * それでよいが、解析へ送る経路では原寸(1枚5MBまで × 最大10枚)がそのまま
 * アップロードされ、モバイル回線では送り切る前に接続が切れて「Failed to fetch」に
 * なる。**レスポンスが返らない失敗はサーバ側では何も出せない**ので、送る前に落として
 * 理由を伝える。デコードできない写真はサーバ側のAIも読めないため、失うものも無い。
 *
 * 縮小不要なサイズでも必ず再エンコードする(forceReencode)。そうすると「返り値が
 * 引数と同一 = ブラウザで画像として処理できなかった」が一対一で対応し、判定が曖昧に
 * ならない。
 */
export async function downscaleForAnalysis(
	file: Blob,
	{
		maxDimension,
		quality,
		/** エラー文言に出す「N枚目」。1始まり。 */
		photoNumber,
	}: { maxDimension: number; quality: number; photoNumber: number },
): Promise<Blob> {
	const blob = await downscaleImage(file, {
		maxDimension,
		quality,
		forceReencode: true,
	});
	if (blob === file && blob.size > ANALYSIS_UNRESIZED_MAX_BYTES) {
		throw new Error(unresizablePhotoMessage(photoNumber));
	}
	return blob;
}
