import { createFileRoute } from "@tanstack/react-router";
import { GRAPE_VARIETIES } from "#/lib/wine/varieties";

// ブドウ品種マスタ(公開データ・認証不要)。
export const Route = createFileRoute("/api/wine/varieties")({
	server: {
		handlers: {
			GET: () =>
				Response.json(
					{ varieties: GRAPE_VARIETIES },
					{
						headers: {
							"Cache-Control": "public, max-age=3600",
							// MCP App(ホスト側オリジンのsandbox iframe)から品種マスタを
							// fetchするため。公開データなのでワイルドカードで問題ない
							"Access-Control-Allow-Origin": "*",
						},
					},
				),
		},
	},
});
