import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES } from "#/lib/drunk-wine/photo";
import { setDrunkWinePhoto } from "#/lib/services/drunk-wine-service";

// マイセラーのワイン写真アップロード。/api/upload(アバター専用・
// ユーザ毎1キー固定)とはキー体系が異なるため別ルートにする。
// FormData: photo=File, entryId=対象エントリID(本人所有のみ。所有権は
// サービス層で userId と突合)。

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const Route = createFileRoute("/api/wine-photos")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await auth.api.getSession({
					headers: request.headers,
				});
				if (!session) return jsonError("Unauthorized", 401);

				let formData: FormData;
				try {
					formData = await request.formData();
				} catch {
					return jsonError("Invalid form data", 400);
				}

				const file = formData.get("photo");
				const entryId = formData.get("entryId");
				if (!(file instanceof File)) {
					return jsonError("No photo file provided", 400);
				}
				if (typeof entryId !== "string" || entryId.length === 0) {
					return jsonError("No entryId provided", 400);
				}
				if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
					return jsonError("Unsupported image type", 400);
				}
				if (file.size > MAX_PHOTO_BYTES) {
					return jsonError("File exceeds 5 MB limit", 400);
				}

				try {
					const entry = await setDrunkWinePhoto(
						session.user.id,
						entryId,
						await file.arrayBuffer(),
						file.type,
					);
					// 差し替え時にブラウザへ再取得させるキャッシュバスタ(表示側の
					// ?v=updatedAt と同じ値に揃える)
					const imageUrl = `${entry.photoUrl}?v=${entry.updatedAt}`;
					return new Response(JSON.stringify({ imageUrl, entry }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					return jsonError(message, message === "Entry not found" ? 404 : 400);
				}
			},
		},
	},
});
