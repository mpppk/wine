import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";

const ALLOWED_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);
const MAX_BYTES = 5 * 1024 * 1024;
const EXT_MAP: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

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

				if (!ALLOWED_TYPES.has(file.type)) {
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

				const ext = EXT_MAP[file.type];
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
