import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import {
	MAX_PHOTO_BYTES as MAX_BYTES,
	photoExtForMime,
	sniffImageMime,
} from "#/lib/drunk-wine/photo";
import { logError } from "#/lib/logger";

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const Route = createFileRoute("/api/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await auth.api.getSession({
					headers: request.headers,
				});
				if (!session) {
					return jsonError("Unauthorized", 401);
				}

				let formData: FormData;
				try {
					formData = await request.formData();
				} catch {
					return jsonError("Invalid form data", 400);
				}

				const file = formData.get("avatar");
				if (!(file instanceof File)) {
					return jsonError("No avatar file provided", 400);
				}

				// クライアント申告の Content-Type は継承プロパティすり抜け防止のため
				// photoExtForMime で早期チェックするが、保存する MIME/拡張子は下で
				// 実バイト(マジックバイト)から確定する(申告値は信用しない)。
				if (!photoExtForMime(file.type)) {
					return jsonError("Unsupported image type", 400);
				}
				if (file.size > MAX_BYTES) {
					return jsonError("File exceeds 5 MB limit", 400);
				}

				let buffer: ArrayBuffer;
				try {
					buffer = await file.arrayBuffer();
				} catch (e) {
					logError("avatar upload: reading file body failed", {
						userId: session.user.id,
						err: e,
					});
					return jsonError("Upload failed", 500);
				}

				// マジックバイトで実フォーマットを判定し、保存・配信する Content-Type を
				// サーバが確定する。中身がHTML/スクリプトの画像偽装(申告 image/png 等)は
				// ここで弾く。拡張子も実MIMEから決める。
				const sniffedMime = sniffImageMime(new Uint8Array(buffer));
				const ext = sniffedMime ? photoExtForMime(sniffedMime) : undefined;
				if (!sniffedMime || !ext) {
					return jsonError("Unsupported image type", 400);
				}

				const r2Key = `avatars/${session.user.id}.${ext}`;
				try {
					await env.AVATARS.put(r2Key, buffer, {
						httpMetadata: { contentType: sniffedMime },
					});
				} catch (e) {
					logError("avatar upload: R2 put failed", {
						userId: session.user.id,
						r2Key,
						err: e,
					});
					return jsonError("Upload failed", 500);
				}

				// Cache-busting query param so browsers refetch after re-upload
				const imageUrl = `/api/images/${r2Key}?v=${Date.now()}`;

				return new Response(JSON.stringify({ imageUrl }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
	},
});
