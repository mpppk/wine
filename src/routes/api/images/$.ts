import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/images/$")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const r2Key = (params as Record<string, string>)._splat;

				if (!r2Key) {
					return new Response("Not found", { status: 404 });
				}

				const ifNoneMatch = request.headers.get("If-None-Match");
				const object = await env.AVATARS.get(r2Key);

				if (!object) {
					return new Response("Not found", { status: 404 });
				}

				const etag = `"${object.etag}"`;
				if (ifNoneMatch === etag) {
					return new Response(null, { status: 304 });
				}

				return new Response(object.body, {
					headers: {
						"Content-Type":
							object.httpMetadata?.contentType ?? "application/octet-stream",
						"Cache-Control": "public, max-age=31536000, immutable",
						ETag: etag,
						"Content-Length": String(object.size),
					},
				});
			},
		},
	},
});
