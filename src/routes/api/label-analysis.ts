import { createFileRoute } from "@tanstack/react-router";
import { MAX_PHOTOS_PER_ENTRY } from "#/lib/drunk-wine/photo";
import {
	API_ERROR_MESSAGES,
	apiJson,
	apiJsonError,
	readImageFormData,
	requireApiSession,
	validateDeclaredPhotoFiles,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";
import { analyzeWineLabel } from "#/lib/services/ai-service";

// エチケット画像のAI解析(マイセラーの自動入力候補)。/api/wine-photos と同じ
// FormData受け取りだが、こちらはR2へ保存せず Workers AI で項目抽出した
// suggestions を返すだけ。エントリ作成前(フォーム入力中)に呼べるよう
// entryId は受け取らない。複数枚(photo を複数)を受け取り総合判断させる。
// クレジット不足時は 200 で { blocked: true } を返す(地域Q&Aの server fn と同じ規約)。

/** バイト列を data URI に変換する(btoa はチャンクで呼び巨大文字列連結を避ける)。 */
function toDataUrl(buffer: ArrayBuffer, mimeType: string): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

export const Route = createFileRoute("/api/label-analysis")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const formData = await readImageFormData(request);
				if (formData instanceof Response) return formData;

				const files = formData
					.getAll("photo")
					.filter((f): f is File => f instanceof File);
				if (files.length === 0) {
					return apiJsonError("No photo file provided", 400);
				}
				if (files.length > MAX_PHOTOS_PER_ENTRY) {
					return apiJsonError(API_ERROR_MESSAGES.tooManyPhotos, 400);
				}
				const invalid = validateDeclaredPhotoFiles(files);
				if (invalid) return invalid;

				try {
					const imageDataUrls = await Promise.all(
						files.map(async (file) =>
							toDataUrl(await file.arrayBuffer(), file.type),
						),
					);
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
