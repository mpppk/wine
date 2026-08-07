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
	consumeLabelAnalysisJob,
	getLabelAnalysisJob,
	getLabelAnalysisJobBadge,
	listPendingLabelAnalysisJobs,
	submitLabelAnalysisJob,
} from "#/lib/services/label-job-service";

// エチケット解析の**非同期ジョブ**の投入・状態取得(Issue #460)。
//
// 同期版は /api/label-analysis で、そちらは1リクエストで推論まで完結する(フォームが待つ)。
// こちらは「投入したらページを離れてよい」経路で、
//
//   POST  /api/label-analysis-jobs             FormData(photo=File × 1..6)→ { jobId, status }
//   GET   /api/label-analysis-jobs?id=…        1件の状態(終端なら suggestions / error と残高)
//   GET   /api/label-analysis-jobs             未終端 + 未受け取りのジョブ一覧
//   GET   /api/label-analysis-jobs?badge=1     件数だけ(マイセラーのバッジ用。#462)
//   PATCH /api/label-analysis-jobs?id=…        完了ジョブを受け取り済みにして候補を返す(#462)
//
// を提供する。受け取り・検証の骨格は form-api の共通関門を共有する(#260/#174 の方針)。
// クレジット不足時は 200 で { blocked: true } を返す(同期経路・地域Q&Aと同じ規約)。
//
// **受け取り(PATCH)を GET と分けている**のは、既読化が書き込みだからで、
// `requireApiSession` のなりすまし拒否・スロットルが書き込みメソッドにだけ効く(#116/#397)
// のもこの分離に乗っている。

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

				const params = new URL(request.url).searchParams;
				const jobId = params.get("id");
				try {
					// バッジは全ページの共通ヘッダから引かれうるので、行の中身
					// (suggestions は数KBある)を運ばない専用の形を返す。
					if (params.get("badge")) {
						return apiJson(await getLabelAnalysisJobBadge(session.user.id));
					}
					if (!jobId) {
						return apiJson({
							jobs: await listPendingLabelAnalysisJobs(session.user.id),
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

			// 完了ジョブの受け取り(#462)。既読化と候補の取得を1操作にしてある——
			// 別々にすると「開いたのにバッジが減らない」「減ったのに候補が出ない」の
			// 両方が起きうる。二重に開いても候補は返る(2回目は alreadyConsumed)。
			PATCH: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const jobId = new URL(request.url).searchParams.get("id");
				if (!jobId) return apiJsonError("No job id provided", 400);
				try {
					return apiJson(await consumeLabelAnalysisJob(session.user.id, jobId));
				} catch (e) {
					if (e instanceof HttpError) {
						return apiJsonError(e.message, e.status);
					}
					logError("label analysis job consume failed", {
						userId: session.user.id,
						jobId,
						err: e,
					});
					return apiJsonError("解析結果の取得に失敗しました", 500);
				}
			},
		},
	},
});
