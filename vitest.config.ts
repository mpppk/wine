import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest uses its own config instead of the app's vite.config.ts so it does not
// load the Cloudflare / TanStack Start plugins. Those plugins configure a Worker
// (`ssr`) environment whose `resolve.external` is rejected by the Cloudflare
// plugin's validation when Vite resolves the config in a dev-server-like flow,
// which is exactly what Vitest does on startup.
const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [react()],
	test: {
		environment: "jsdom",
		// passWithNoTests は付けない。include グロブの変更ミスや tsconfigPaths の
		// 解決失敗でテストが0件収集になっても緑になってしまうため(常在するテストが
		// あるリポジトリなので0件は常に異常)。既定の false のまま0件を失敗として検出する。
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// 収集対象外(型定義・生成物・エントリ)。カバレッジは可視化目的で、しきい値は設けない。
			exclude: ["src/**/*.d.ts", "src/routeTree.gen.ts"],
		},
	},
});

export default config;
