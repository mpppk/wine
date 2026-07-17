import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import {
	PHOTO_EXT_MAP as EXT_MAP,
	MAX_PHOTO_BYTES as MAX_BYTES,
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

				// EXT_MAP を許可MIMEの単一情報源にする。ext が引けなければ未対応の型
				// (別途 ALLOWED_TYPES を突き合わせる二重管理をやめ、型でも安全にする)。
				const ext = EXT_MAP[file.type];
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
