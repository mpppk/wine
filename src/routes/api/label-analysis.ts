import { createFileRoute } from "@tanstack/react-router";
import {
	apiJson,
	apiJsonError,
	fileToDataUrl,
	readImageFormData,
	readPhotoFiles,
	requireApiSession,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";
import { analyzeWineLabel } from "#/lib/services/ai-service";

// エチケット画像のAI解析(マイセラーの自動入力候補)。/api/wine-photos と同じ
// FormData受け取りだが、こちらはR2へ保存せず AI で項目抽出した
// suggestions を返すだけ。エントリ作成前(フォーム入力中)に呼べるよう
// entryId は受け取らない。複数枚(photo を複数)を受け取り総合判断させる。
// クレジット不足時は 200 で { blocked: true } を返す(地域Q&Aの server fn と同じ規約)。
//
// 複数銘柄が写った写真からの一括抽出は /api/wine-list-analysis(Issue #358)。
// 受け取り・検証の骨格は form-api の共通関門を共有する。

export const Route = createFileRoute("/api/label-analysis")({
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
					const imageDataUrls = await Promise.all(files.map(fileToDataUrl));
					const result = await analyzeWineLabel(session.user.id, {
						imageDataUrls,
					});
					return apiJson(result);
				} catch (e) {
					// 詳細はAIモデル都合のことが多く、ユーザに出しても行動できないため固定文言。
					// ただしサーバ側には文脈付きで記録し、MCP経路(tools.ts)と観測を揃える(#156)。
					logError("label analysis failed", {
						userId: session.user.id,
						err: e,
					});
					return apiJsonError("エチケットの解析に失敗しました", 500);
				}
			},
		},
	},
});
