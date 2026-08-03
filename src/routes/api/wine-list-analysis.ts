import { createFileRoute } from "@tanstack/react-router";
import { HttpError } from "#/lib/errors";
import {
	apiJson,
	apiJsonError,
	fileToDataUrl,
	readImageFormData,
	readPhotoFiles,
	requireApiSession,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import { analyzeWineList } from "#/lib/services/ai-service";

// 複数写真からのワイン一括抽出(Issue #358)。レストランのワインリスト・ショップの
// 陳列を撮った写真から銘柄の配列を取り出し、レビュー画面に出す候補を返す。
//
// /api/label-analysis(1解析 = 1本)との違い:
//  - 受け取る枚数の上限が MAX_PHOTOS_PER_IMPORT_BATCH(10枚)。エントリ写真の上限
//    (6枚)とは別物なので、FormData のサイズ前チェックにも同じ値を渡す
//  - 返すのは suggestions 1件ではなく候補の配列 + サマリ(重複統合・既存一致・打ち切り)
//
// R2 への保存はしない(写真の実体はバッチ確定後に /api/import-batch-photos で保存する
// = PR3)。クレジット不足時は 200 で { blocked: true } を返す(既存の解析経路と同じ規約)。

export const Route = createFileRoute("/api/wine-list-analysis")({
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

				const files = readPhotoFiles(formData, MAX_PHOTOS_PER_IMPORT_BATCH);
				if (files instanceof Response) return files;

				try {
					const imageDataUrls = await Promise.all(files.map(fileToDataUrl));
					const result = await analyzeWineList(session.user.id, {
						imageDataUrls,
					});
					return apiJson(result);
				} catch (e) {
					// HttpError は「銘柄が多すぎて出力が切れた(400)」「この環境では使えない(503)」の
					// ように**ユーザが次の行動を選べる**理由なので、文言をそのまま返す。それ以外は
					// AIモデル都合で行動できないため固定文言にし、詳細はサーバ側に記録する(#156)。
					logError("wine list analysis failed", {
						userId: session.user.id,
						photoCount: files.length,
						err: e,
					});
					if (e instanceof HttpError) return apiJsonError(e.message, e.status);
					return apiJsonError("写真の解析に失敗しました", 500);
				}
			},
		},
	},
});
