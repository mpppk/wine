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
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { saveImportBatchPhotos } from "#/lib/services/drunk-wine-service";

// 一括登録バッチの写真アップロード(Issue #358 の2段階目)。R2キーが batchId 依存
// なので、bulkRegisterFromScan でバッチが確定してからこちらへ送る。
//
// /api/wine-photos との違い:
//  - 全置換の同期ではなく**1回きりの保存**(目撃記録の photoIndex が既に配列を
//    指しているため、差し替え・並べ替えの概念が無い)。保存済みなら 409
//  - 枚数上限が MAX_PHOTOS_PER_IMPORT_BATCH(10枚)
//  - 一覧用サムネイルは送らない。リスト写真を並べる画面が無く、表示は目撃履歴の
//    1枚だけなので、配信側の原寸フォールバックで足りる
//
// FormData:
//  - batchId=対象バッチID(本人所有のみ。所有権はサービス層で userId と突合)
//  - photo=File(撮影順。この順が photoIndex になる)

export const Route = createFileRoute("/api/import-batch-photos")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const formData = await readImageFormData(
					request,
					MAX_PHOTOS_PER_IMPORT_BATCH,
				);
				if (formData instanceof Response) return formData;

				const batchId = formData.get("batchId");
				if (typeof batchId !== "string" || batchId.length === 0) {
					return apiJsonError("No batchId provided", 400);
				}

				const files = readPhotoFiles(formData, MAX_PHOTOS_PER_IMPORT_BATCH);
				if (files instanceof Response) return files;

				try {
					const batch = await saveImportBatchPhotos(
						session.user.id,
						batchId,
						await Promise.all(
							files.map(async (file) => ({
								bytes: await file.arrayBuffer(),
								mimeType: file.type,
							})),
						),
					);
					return apiJson({ batch });
				} catch (e) {
					// サービス層の HttpError(404/409/400)は status と文言を透過する(#153)
					if (e instanceof HttpError) {
						return apiJsonError(e.message, e.status);
					}
					logError("import batch photo save failed", {
						userId: session.user.id,
						batchId,
						err: e,
					});
					return apiJsonError("写真の保存に失敗しました", 500);
				}
			},
		},
	},
});
