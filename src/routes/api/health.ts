import { createFileRoute } from "@tanstack/react-router";
import { checkHealth } from "#/lib/services/health-service";

// スモークテスト(scripts/smoke.sh)とアップタイム監視向けの未認証ヘルスチェック(#336)。
// 唯一「未認証で D1 に SELECT が走る」経路で、DB 接続性とマイグレーション適用状態を返す。
//
// 返すのはスキーマ世代(マイグレーションのファイル名)だけで、利用者データには触れない。
// 監視が古い応答を掴まないよう no-store にする。
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async () => {
				const result = await checkHealth();
				return new Response(JSON.stringify(result), {
					// 異常時は 503。監視・スモークの双方が「200 かつ ok:true」だけを健全と見なせる。
					status: result.ok ? 200 : 503,
					headers: {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			},
		},
	},
});
