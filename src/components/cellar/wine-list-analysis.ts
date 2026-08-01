import { downscaleImage } from "#/components/cellar/photo-resize";
import type { AnalyzeWineListResult } from "#/lib/services/ai-service";

// 写真からの一括抽出(Issue #358)のクライアント側ヘルパー。選択した写真を解析用に
// 縮小して /api/wine-list-analysis へ送る。エチケット解析(label-analysis.ts)と
// 同じ流儀だが、縮小サイズと上限枚数が違う。

/**
 * 解析用に縮小する際の長辺の上限(px)。エチケット解析(1280px)より大きいのは、
 * ワインリストは**1枚に数十行の小さな文字**が並ぶため。1280pxまで落とすと
 * 生産者名やヴィンテージが潰れて読み取り精度が落ちる。
 * サーバ側の見積(AI_WINE_LIST_IMAGE_TOKEN_ESTIMATE)もこの前提で置いてある。
 */
const ANALYSIS_MAX_DIMENSION = 1600;
const ANALYSIS_JPEG_QUALITY = 0.85;

/**
 * 選択中の写真を縮小して一括抽出APIへ送り、銘柄候補を受け取る。失敗時は Error を throw。
 * files は撮影順(この順が photo_indexes と目撃記録の photoIndex になる)。
 */
export async function analyzeWineListPhotos(
	files: File[],
): Promise<AnalyzeWineListResult> {
	if (files.length === 0) throw new Error("写真を選択してください");
	const form = new FormData();
	for (const file of files) {
		const blob = await downscaleImage(file, {
			maxDimension: ANALYSIS_MAX_DIMENSION,
			quality: ANALYSIS_JPEG_QUALITY,
		});
		form.append(
			"photo",
			blob instanceof File
				? blob
				: new File([blob], "wine-list.jpg", { type: blob.type }),
		);
	}
	const res = await fetch("/api/wine-list-analysis", {
		method: "POST",
		body: form,
	});
	const body = (await res.json()) as AnalyzeWineListResult & { error?: string };
	if (!res.ok) {
		throw new Error(body.error ?? "写真の解析に失敗しました");
	}
	return body;
}

/** 一括登録の確定後に、バッチの写真の実体をアップロードする(2段階目)。 */
export async function uploadImportBatchPhotos(
	batchId: string,
	files: File[],
): Promise<void> {
	if (files.length === 0) return;
	const form = new FormData();
	form.append("batchId", batchId);
	// 保存する写真は原寸のまま送る(解析用の縮小は解析にだけ使う。マイセラーの
	// 写真アップロードと同じ方針)
	for (const file of files) form.append("photo", file);
	const res = await fetch("/api/import-batch-photos", {
		method: "POST",
		body: form,
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? "写真の保存に失敗しました");
	}
}
