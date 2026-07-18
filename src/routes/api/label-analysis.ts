import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import {
	ALLOWED_PHOTO_TYPES,
	MAX_PHOTO_BYTES,
	MAX_PHOTOS_PER_ENTRY,
} from "#/lib/drunk-wine/photo";
import { analyzeWineLabel } from "#/lib/services/ai-service";

// エチケット画像のAI解析(マイセラーの自動入力候補)。/api/wine-photos と同じ
// FormData受け取りだが、こちらはR2へ保存せず Workers AI で項目抽出した
// suggestions を返すだけ。エントリ作成前(フォーム入力中)に呼べるよう
// entryId は受け取らない。複数枚(photo を複数)を受け取り総合判断させる。
// クレジット不足時は 200 で { blocked: true } を返す(地域Q&Aの server fn と同じ規約)。

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

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
				const session = await auth.api.getSession({
					headers: request.headers,
				});
				if (!session) return json({ error: "Unauthorized" }, 401);

				// formData() はボディ全体をメモリに載せるため、明らかに大きい
				// リクエストはパース前に弾く(全枚数ぶん + multipart境界等のオーバーヘッド)
				const contentLength = Number(
					request.headers.get("content-length") ?? 0,
				);
				if (
					contentLength >
					MAX_PHOTO_BYTES * MAX_PHOTOS_PER_ENTRY + 64 * 1024
				) {
					return json({ error: "Files exceed size limit" }, 413);
				}

				let formData: FormData;
				try {
					formData = await request.formData();
				} catch {
					return json({ error: "Invalid form data" }, 400);
				}

				const files = formData
					.getAll("photo")
					.filter((f): f is File => f instanceof File);
				if (files.length === 0) {
					return json({ error: "No photo file provided" }, 400);
				}
				if (files.length > MAX_PHOTOS_PER_ENTRY) {
					return json(
						{ error: `写真は最大${MAX_PHOTOS_PER_ENTRY}枚までです` },
						400,
					);
				}
				for (const file of files) {
					if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
						return json({ error: "Unsupported image type" }, 400);
					}
					if (file.size > MAX_PHOTO_BYTES) {
						return json({ error: "File exceeds 5 MB limit" }, 400);
					}
				}

				try {
					const imageDataUrls = await Promise.all(
						files.map(async (file) =>
							toDataUrl(await file.arrayBuffer(), file.type),
						),
					);
					const result = await analyzeWineLabel(session.user.id, {
						imageDataUrls,
					});
					return json(result);
				} catch {
					// 詳細はAIモデル都合のことが多く、ユーザに出しても行動できないため固定文言
					return json({ error: "エチケットの解析に失敗しました" }, 500);
				}
			},
		},
	},
});
