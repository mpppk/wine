import { createFileRoute } from "@tanstack/react-router";
import { DEFAULT_LABEL_JOB_KIND, LABEL_JOB_KINDS } from "#/lib/ai/label-job";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import { HttpError } from "#/lib/errors";
import {
	apiJson,
	apiJsonError,
	readImageFormData,
	readPhotoFiles,
	requireApiSession,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { buildPendingNotification } from "#/lib/push/notification";
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
//   GET   /api/label-analysis-jobs?notification=1  Service Worker が出す通知の内容(#466)
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

				// **ボディの上限は多いほうの種別で取る**(#474)。種別は formData の中にあり、
				// 読む前には分からない。ここを枚数の上限として使うのではなく、枚数は種別が
				// 分かってから `readPhotoFiles` で締める。
				const formData = await readImageFormData(
					request,
					MAX_PHOTOS_PER_IMPORT_BATCH,
				);
				if (formData instanceof Response) return formData;

				// 解析の種別(#474)。既定はエチケット解析で、一括抽出は明示指定する。
				// **許可リストで照合する**(未知の値は 400)——素通しにすると、枚数の上限や
				// 見積の分岐に想定外の値が流れる。
				const rawKind = formData.get("kind");
				const kind =
					typeof rawKind === "string" && rawKind.length > 0
						? LABEL_JOB_KINDS.find((k) => k === rawKind)
						: DEFAULT_LABEL_JOB_KIND;
				if (!kind) return apiJsonError("対応していない解析種別です", 400);

				// 枚数の上限は種別で違う。サービス層も同じ判定を持つが、**大きすぎる
				// リクエストをバイト列に展開する前に**ここで落とす。
				const files = readPhotoFiles(
					formData,
					kind === "wine_list"
						? MAX_PHOTOS_PER_IMPORT_BATCH
						: MAX_PHOTOS_PER_ENTRY,
				);
				if (files instanceof Response) return files;

				try {
					const photos = await Promise.all(
						files.map(async (file) => ({
							bytes: new Uint8Array(await file.arrayBuffer()),
							mimeType: file.type,
						})),
					);
					return apiJson(
						await submitLabelAnalysisJob(session.user.id, photos, kind),
					);
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
					// Service Worker が通知を組むための内容(#466)。プッシュは本文なしで
					// 「何かあった」しか伝えないので、**文言と遷移先はここで決めて渡す**
					// (プレーンJSの SW に散らすと、テストの効かない所でドリフトする)。
					// 受け取り待ちが無ければ `notification: null`。
					if (params.get("notification")) {
						const badge = await getLabelAnalysisJobBadge(session.user.id);
						return apiJson({ notification: buildPendingNotification(badge) });
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
