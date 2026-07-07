import { createFileRoute } from "@tanstack/react-router";
import { listRegions } from "#/lib/wine/service";

// 地域一覧(公開データ・認証不要)。フロントとMCP双方の情報源になる。
export const Route = createFileRoute("/api/wine/regions")({
	server: {
		handlers: {
			GET: () =>
				Response.json(
					{ regions: listRegions() },
					{ headers: { "Cache-Control": "public, max-age=3600" } },
				),
		},
	},
});
