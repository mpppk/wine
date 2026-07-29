import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import {
	photoExtForMime,
	resolveStoredPhotoMime,
} from "#/lib/drunk-wine/photo";
import {
	API_ERROR_MESSAGES,
	apiJson,
	apiJsonError,
	readImageFormData,
	requireApiSession,
	validateDeclaredPhotoFile,
} from "#/lib/images/form-api";
import { logError } from "#/lib/logger";

export const Route = createFileRoute("/api/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await requireApiSession(request);
				if (session instanceof Response) return session;

				const formData = await readImageFormData(request);
				if (formData instanceof Response) return formData;

				const file = formData.get("avatar");
				if (!(file instanceof File)) {
					return apiJsonError("No avatar file provided", 400);
				}

				// 申告値での足切り(許可MIME・サイズ)。保存する MIME は下で実バイトから確定する。
				const invalid = validateDeclaredPhotoFile(file);
				if (invalid) return invalid;

				let buffer: ArrayBuffer;
				try {
					buffer = await file.arrayBuffer();
				} catch (e) {
					logError("avatar upload: reading file body failed", {
						userId: session.user.id,
						err: e,
					});
					return apiJsonError("Upload failed", 500);
				}

				// マジックバイトで実フォーマットを判定し、保存・配信する Content-Type を
				// サーバが確定する。中身がHTML/スクリプトの画像偽装(申告 image/png 等)は
				// ここで弾く。拡張子も実MIMEから決める。
				//
				// ワイン写真経路と**同じ関門**(resolveStoredPhotoMime)を通す(#260)。以前は
				// アバターだけ sniff 結果を無条件採用しており、申告と実体が食い違う画像が
				// アバターでは通りワイン写真では弾かれるという非対称があった。厳しい側
				// (申告と実体の一致を要求)へ揃える。
				const storedMime = resolveStoredPhotoMime(
					new Uint8Array(buffer),
					file.type,
				);
				const ext = storedMime ? photoExtForMime(storedMime) : undefined;
				if (!storedMime || !ext) {
					return apiJsonError(API_ERROR_MESSAGES.unsupportedImageType, 400);
				}

				const r2Key = `avatars/${session.user.id}.${ext}`;
				try {
					await env.AVATARS.put(r2Key, buffer, {
						httpMetadata: { contentType: storedMime },
					});
				} catch (e) {
					logError("avatar upload: R2 put failed", {
						userId: session.user.id,
						r2Key,
						err: e,
					});
					return apiJsonError("Upload failed", 500);
				}

				// Cache-busting query param so browsers refetch after re-upload
				const imageUrl = `/api/images/${r2Key}?v=${Date.now()}`;

				return apiJson({ imageUrl });
			},
		},
	},
});
