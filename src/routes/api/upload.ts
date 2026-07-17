import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import {
	MAX_PHOTO_BYTES as MAX_BYTES,
	photoExtForMime,
} from "#/lib/drunk-wine/photo";

export const Route = createFileRoute("/api/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const session = await auth.api.getSession({
					headers: request.headers,
				});
				if (!session) {
					return new Response(JSON.stringify({ error: "Unauthorized" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					});
				}

				let formData: FormData;
				try {
					formData = await request.formData();
				} catch {
					return new Response(JSON.stringify({ error: "Invalid form data" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}

				const file = formData.get("avatar");
				if (!(file instanceof File)) {
					return new Response(
						JSON.stringify({ error: "No avatar file provided" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}

				// 拡張子(= 許可MIMEの単一情報源)を安全に解決する。別途 ALLOWED_TYPES を
				// 突き合わせる二重管理はやめ、継承プロパティ経由の allowlist すり抜けは
				// photoExtForMime 側で弾く。未対応の型は 400。
				const ext = photoExtForMime(file.type);
				if (!ext) {
					return new Response(
						JSON.stringify({ error: "Unsupported image type" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				if (file.size > MAX_BYTES) {
					return new Response(
						JSON.stringify({ error: "File exceeds 5 MB limit" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}

				const r2Key = `avatars/${session.user.id}.${ext}`;
				const buffer = await file.arrayBuffer();
				await env.AVATARS.put(r2Key, buffer, {
					httpMetadata: { contentType: file.type },
				});

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
