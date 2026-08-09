import { downscaleForAnalysis } from "#/components/cellar/photo-resize";
import { DEFAULT_LABEL_JOB_KIND, type LabelJobKind } from "#/lib/ai/label-job";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { postImageForm } from "#/lib/images/form-client";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import type {
	LabelAnalysisJobBadge,
	LabelAnalysisJobView,
	LabelJobSighting,
	SubmitLabelAnalysisJobResult,
} from "#/lib/services/label-job-service";

// エチケット自動入力のクライアント側ヘルパー。現在フォームに添付中の写真(新規ファイル+
// 保存済みの既存写真)をすべて解析用に縮小して送り、複数枚を総合判断させる。縮小はAI入力
// トークン(=クレジット)と転送量の削減が目的で、保存用のオリジナル写真
// (/api/wine-photos)には影響しない。
//
// **UI からの解析はすべてジョブ経路**(#462 / #464)。手動のボタンも、一括登録からの
// 引き継ぎ直後の自動実行(#416)も `submitLabelAnalysisJob` を通り、結果はポーリング
// (`fetchLabelAnalysisJob`)か、離脱した場合はマイセラーのバッジから受け取る。
//
// 同期API(`/api/label-analysis`)はサーバ側に残っているが、この画面からは呼ばない
// (17〜31秒フォームを拘束するため。#463 の本番実測)。

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

/** 添付中の全写真を解析用に縮小して FormData に積む。2つの経路が共有する。 */
async function buildAnalysisForm(
	sources: AnalysisPhotoSource[],
): Promise<FormData> {
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
	return form;
}

/**
 * 添付中の全写真を解析ジョブとして**投入する**(#462)。返るのは jobId で、解析結果は
 * ポーリング(`fetchLabelAnalysisJob`)で受け取る。
 *
 * 投入が返った時点でサーバ側に予約と写真が載っているので、ここから先はページを離れてよい。
 */
export async function submitLabelAnalysisJob(
	sources: AnalysisPhotoSource[],
	/** 解析の種別(#474)。既定はエチケット解析(1本)。 */
	kind: LabelJobKind = DEFAULT_LABEL_JOB_KIND,
	/**
	 * 写真ウィザードで入力した「どこで・いつ撮ったか」(#498)。ジョブに残しておかないと、
	 * 完了を待たずに離脱した回の受け取りで場所・見かけた日が復元できない。
	 */
	sighting?: LabelJobSighting,
): Promise<SubmitLabelAnalysisJobResult> {
	const form = await buildAnalysisForm(sources);
	// 既定と同じでも送る(サーバ側の分岐が「省略 = label」に依存し続けないように)。
	form.append("kind", kind);
	if (sighting?.placeId) form.append("placeId", sighting.placeId);
	if (sighting?.newPlaceName)
		form.append("newPlaceName", sighting.newPlaceName);
	if (sighting?.seenOn) form.append("seenOn", sighting.seenOn);
	return postImageForm<SubmitLabelAnalysisJobResult>(
		"/api/label-analysis-jobs",
		form,
		{
			fallbackMessage: "解析の受付に失敗しました",
			// 枚数の上限は種別で違う(一括抽出はリストや棚を分割して撮るぶん多い)。
			maxPhotos:
				kind === "wine_list"
					? MAX_PHOTOS_PER_IMPORT_BATCH
					: MAX_PHOTOS_PER_ENTRY,
		},
	);
}

/** JSON を取り、エラーレスポンスはサーバの文言で throw する共通の受け口。 */
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const body = await res
		.json()
		.then((json) => json as T & { error?: unknown })
		.catch(() => null);
	if (!res.ok) {
		throw new Error(
			typeof body?.error === "string"
				? body.error
				: "解析状況の取得に失敗しました",
		);
	}
	if (body === null) throw new Error("解析状況の取得に失敗しました");
	return body;
}

/** ジョブ1件の状態を取る(ポーリングの本体)。 */
export async function fetchLabelAnalysisJob(
	jobId: string,
): Promise<LabelAnalysisJobView> {
	return getJson<LabelAnalysisJobView>(
		`/api/label-analysis-jobs?id=${encodeURIComponent(jobId)}`,
	);
}

/** マイセラーのバッジの件数を取る(行の中身は運ばれない)。 */
export async function fetchLabelAnalysisJobBadge(): Promise<LabelAnalysisJobBadge> {
	return getJson<LabelAnalysisJobBadge>("/api/label-analysis-jobs?badge=1");
}

/**
 * 完了ジョブを受け取り済みにして候補を取る(#462)。既読化と取得が1操作なので、
 * 「開いたのにバッジが減らない」「減ったのに候補が出ない」がどちらも起きない。
 */
export async function consumeLabelAnalysisJob(
	jobId: string,
): Promise<{ view: LabelAnalysisJobView; alreadyConsumed: boolean }> {
	return getJson<{ view: LabelAnalysisJobView; alreadyConsumed: boolean }>(
		`/api/label-analysis-jobs?id=${encodeURIComponent(jobId)}`,
		{ method: "PATCH" },
	);
}
