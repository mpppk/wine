import { createFileRoute } from "@tanstack/react-router";
import { HttpError } from "#/lib/errors";
import {
	apiJson,
	apiJsonError,
	readImageFormData,
	readPhotoFiles,
	requireApiSession,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";
import {
	getLabelAnalysisJob,
	listActiveLabelAnalysisJobs,
	submitLabelAnalysisJob,
} from "#/lib/services/label-job-service";

// エチケット解析の**非同期ジョブ**の投入・状態取得(Issue #460)。
//
// 同期版は /api/label-analysis で、そちらは1リクエストで推論まで完結する(フォームが待つ)。
// こちらは「投入したらページを離れてよい」経路で、
//
//   POST /api/label-analysis-jobs        FormData(photo=File × 1..6)→ { jobId, status }
//   GET  /api/label-analysis-jobs?id=…   1件の状態(終端なら suggestions / error と残高)
//   GET  /api/label-analysis-jobs        本人の未終端ジョブ一覧(解析中バッジの材料)
//
// を提供する。受け取り・検証の骨格は form-api の共通関門を共有する(#260/#174 の方針)。
// クレジット不足時は 200 で { blocked: true } を返す(同期経路・地域Q&Aと同じ規約)。

export const Route = createFileRoute("/api/label-analysis-jobs")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const formData = await readImageFormData(request);
				if (formData instanceof Response) return formData;

				const files = readPhotoFiles(formData);
				if (files instanceof Response) return files;

				try {
					const photos = await Promise.all(
						files.map(async (file) => ({
							bytes: new Uint8Array(await file.arrayBuffer()),
							mimeType: file.type,
						})),
					);
					return apiJson(await submitLabelAnalysisJob(session.user.id, photos));
				} catch (e) {
					// 入力起因(枚数超過・画像偽装・同時実行上限)は本人が行動できるので
					// そのまま返す。それ以外は固定文言にして文脈をサーバ側にだけ残す(#156)。
					if (e instanceof HttpError) {
						return apiJsonError(e.message, e.status);
					}
					logError("label analysis job submit failed", {
						userId: session.user.id,
						err: e,
					});
					return apiJsonError("解析の受付に失敗しました", 500);
				}
			},

			GET: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const jobId = new URL(request.url).searchParams.get("id");
				try {
					if (!jobId) {
						return apiJson({
							jobs: await listActiveLabelAnalysisJobs(session.user.id),
						});
					}
					return apiJson(await getLabelAnalysisJob(session.user.id, jobId));
				} catch (e) {
					// 他人のジョブ・存在しないIDはサービス層が 404 にしている(IDの存在有無を
					// 漏らさないため、所有権エラーも同じ 404)。
					if (e instanceof HttpError) {
						return apiJsonError(e.message, e.status);
					}
					logError("label analysis job read failed", {
						userId: session.user.id,
						jobId,
						err: e,
					});
					return apiJsonError("解析状況の取得に失敗しました", 500);
				}
			},
		},
	},
});
