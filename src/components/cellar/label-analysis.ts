import { downscaleForAnalysis } from "#/components/cellar/photo-resize";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { postImageForm } from "#/lib/images/form-client";
import type { AnalyzeLabelResult } from "#/lib/services/ai-service";

// エチケット自動入力のクライアント側ヘルパー。現在フォームに添付中の写真(新規ファイル+
// 保存済みの既存写真)をすべて解析用に縮小して /api/label-analysis へ送り、複数枚を
// 総合判断させる。縮小はAI入力トークン(=クレジット)と転送量の削減が目的で、保存用の
// オリジナル写真(/api/wine-photos)には影響しない。

/** 解析対象の写真ソース。新規はFile、既存はサーバ配信URL(同一オリジン)。 */
export type AnalysisPhotoSource = File | { url: string };

/**
 * 解析用に縮小する際の長辺の上限(px)。
 *
 * **`zoom_photo` の拡大元になるので、モデルへ見せる版(1280px)より大きく送る。**
 * ボトル全体が写った写真ではラベルの文字は潰れて読めず、実測では原寸を送っても
 * 改善しなかった(プロバイダが内部で縮小するため)。効いたのはラベル部分の切り出しで、
 * そのためには縮小前の画素がサーバ側に要る。
 *
 * 会話へ載せる版はサーバが 1280px へ落とすので(AI_LABEL_VIEW_MAX_DIMENSION)、
 * ここを上げても毎ターンの入力トークンは増えない。増えるのはアップロード量だけ。
 */
const ANALYSIS_MAX_DIMENSION = 2048;
const ANALYSIS_JPEG_QUALITY = 0.85;

/** 解析ソースを解析用のBlobに解決する。既存写真(URL)は同一オリジンから取得する。 */
async function toAnalysisBlob(source: AnalysisPhotoSource): Promise<Blob> {
	if (source instanceof File) return source;
	const res = await fetch(source.url).catch(() => null);
	if (!res?.ok) throw new Error("既存写真の取得に失敗しました");
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
	for (const [index, source] of sources.entries()) {
		const blob = await downscaleForAnalysis(await toAnalysisBlob(source), {
			maxDimension: ANALYSIS_MAX_DIMENSION,
			quality: ANALYSIS_JPEG_QUALITY,
			photoNumber: index + 1,
		});
		form.append(
			"photo",
			blob instanceof File
				? blob
				: new File([blob], "label.jpg", { type: blob.type }),
		);
	}
	return postImageForm<AnalyzeLabelResult>("/api/label-analysis", form, {
		fallbackMessage: "エチケットの解析に失敗しました",
		maxPhotos: MAX_PHOTOS_PER_ENTRY,
	});
}
