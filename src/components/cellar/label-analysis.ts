import type { AnalyzeLabelResult } from "#/lib/services/ai-service";

// エチケット自動入力のクライアント側ヘルパー。選択済みの写真を解析用に縮小して
// /api/label-analysis へ送る。縮小はAI入力トークン(=クレジット)と転送量の削減が
// 目的で、保存用のオリジナル写真(/api/wine-photos)には影響しない。

/** 解析用に縮小する際の長辺の上限(px)。ラベルの文字が読める程度に保つ。 */
const ANALYSIS_MAX_DIMENSION = 1280;
const ANALYSIS_JPEG_QUALITY = 0.85;

/**
 * 画像を長辺 ANALYSIS_MAX_DIMENSION px 以下のJPEGに縮小する。
 * デコードや変換に失敗した場合は元ファイルのまま返す(サーバ側の5MB制限は
 * フォームで選択時に検証済み)。
 */
async function downscaleForAnalysis(file: File): Promise<Blob> {
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

/** 写真を縮小して解析APIへ送り、自動入力候補を受け取る。失敗時はErrorをthrow。 */
export async function analyzeLabelPhoto(
	file: File,
): Promise<AnalyzeLabelResult> {
	const blob = await downscaleForAnalysis(file);
	const form = new FormData();
	form.append(
		"photo",
		blob instanceof File
			? blob
			: new File([blob], "label.jpg", { type: blob.type }),
	);
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
