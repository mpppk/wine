import type { AnalyzeLabelResult } from "#/lib/services/ai-service";

// エチケット自動入力のクライアント側ヘルパー。現在フォームに添付中の写真(新規ファイル+
// 保存済みの既存写真)をすべて解析用に縮小して /api/label-analysis へ送り、複数枚を
// 総合判断させる。縮小はAI入力トークン(=クレジット)と転送量の削減が目的で、保存用の
// オリジナル写真(/api/wine-photos)には影響しない。

/** 解析対象の写真ソース。新規はFile、既存はサーバ配信URL(同一オリジン)。 */
export type AnalysisPhotoSource = File | { url: string };

/** 解析用に縮小する際の長辺の上限(px)。ラベルの文字が読める程度に保つ。 */
const ANALYSIS_MAX_DIMENSION = 1280;
const ANALYSIS_JPEG_QUALITY = 0.85;

/**
 * 画像を長辺 ANALYSIS_MAX_DIMENSION px 以下のJPEGに縮小する。
 * デコードや変換に失敗した場合は元ファイルのまま返す(サーバ側の5MB制限は
 * フォームで選択時に検証済み)。
 */
async function downscaleForAnalysis(file: Blob): Promise<Blob> {
	try {
		// EXIFの回転をブラウザに解決させてからキャンバスへ描く
		const bitmap = await createImageBitmap(file, {
			imageOrientation: "from-image",
		});
		try {
			const scale = Math.min(
				1,
				ANALYSIS_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height),
			);
			if (scale >= 1 && file.type === "image/jpeg") return file;
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return file;
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/jpeg", ANALYSIS_JPEG_QUALITY),
			);
			return blob ?? file;
		} finally {
			bitmap.close();
		}
	} catch {
		return file;
	}
}

/** 解析ソースを解析用のBlobに解決する。既存写真(URL)は同一オリジンから取得する。 */
async function toAnalysisBlob(source: AnalysisPhotoSource): Promise<Blob> {
	if (source instanceof File) return source;
	const res = await fetch(source.url);
	if (!res.ok) throw new Error("既存写真の取得に失敗しました");
	return res.blob();
}

/**
 * 添付中の全写真を縮小して解析APIへ送り、自動入力候補を受け取る。失敗時はErrorをthrow。
 * sources は表示順。新規ファイルと既存写真(URL)を混在して渡せる。
 */
export async function analyzeLabelPhotos(
	sources: AnalysisPhotoSource[],
): Promise<AnalyzeLabelResult> {
	if (sources.length === 0) throw new Error("写真を選択してください");
	const form = new FormData();
	for (const source of sources) {
		const blob = await downscaleForAnalysis(await toAnalysisBlob(source));
		form.append(
			"photo",
			blob instanceof File
				? blob
				: new File([blob], "label.jpg", { type: blob.type }),
		);
	}
	const res = await fetch("/api/label-analysis", {
		method: "POST",
		body: form,
	});
	const body = (await res.json()) as AnalyzeLabelResult & { error?: string };
	if (!res.ok) {
		throw new Error(body.error ?? "エチケットの解析に失敗しました");
	}
	return body;
}
