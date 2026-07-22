import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest uses its own config instead of the app's vite.config.ts so it does not
// load the Cloudflare / TanStack Start plugins. Those plugins configure a Worker
// (`ssr`) environment whose `resolve.external` is rejected by the Cloudflare
// plugin's validation when Vite resolves the config in a dev-server-like flow,
// which is exactly what Vitest does on startup.
//
// テストは2プロジェクト構成:
//  - unit  : jsdom 上の純関数・スキーマ・コンポーネントのテスト(従来分)。
//            `cloudflare:workers` を import するモジュールは読めないため、
//            純ロジック層(src/lib/<domain>/)のみを対象にする(docs/architecture.md)。
//  - workers: workerd(miniflare) 上で D1 / env バインディングを与えて動かすテスト
//            (`*.workers.test.ts`)。quiz-service の実D1アクセスや MCP ツールの
//            ハンドラなど、`cloudflare:workers` 依存のコードを実機に近い形で検証する。
// どちらも `vitest run` の1コマンドで実行される。

// D1 マイグレーションは Node 側(設定読み込み時)で読み、テスト用の分離D1へ
// setup で適用する(workerd 側は fs を持たないため、バインディング経由で渡す)。
// 連番SQL(NNNN_*.sql)のみを対象にし、本番と同じスキーマ履歴を再現する。
// 連番外の補助ファイルが drizzle/ に混ざっても拾わないよう防御的にフィルタする。
const migrations = (await readD1Migrations("./drizzle")).filter((m) =>
	/^\d+_/.test(m.name),
);

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				resolve: { tsconfigPaths: true },
				plugins: [react()],
				test: {
					name: "unit",
					environment: "jsdom",
					include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
					// workers プロジェクトが拾うテストはこちらでは対象外にする
					exclude: ["src/**/*.workers.test.ts"],
				},
			},
			{
				extends: true,
				resolve: { tsconfigPaths: true },
				plugins: [
					cloudflareTest({
						// wrangler.jsonc は流用せずバインディングを明示する。理由:
						//  - `main`(@tanstack/react-start/server-entry)は Start プラグイン前提で
						//    テストプールでは解決できない。テストはモジュールを直接 import して
						//    関数を呼ぶだけなので Worker エントリは不要。
						//  - AI バインディングはローカルでもリモート接続を張るため、DBアクセスの
						//    テストには不要かつ避けたい。ここでは D1/R2 のみをローカルに用意する。
						// テスト用D1は実行ごとに分離され、本番/プレビューには一切触れない。
						miniflare: {
							compatibilityDate: "2025-09-02",
							compatibilityFlags: ["nodejs_compat"],
							d1Databases: ["DB"],
							r2Buckets: ["AVATARS"],
							bindings: {
								// setup(test/apply-migrations.ts)で適用するマイグレーション本体
								TEST_MIGRATIONS: migrations,
								// ハンドラが絶対URL(geojson_url/map_url等)を組むのに使う
								BETTER_AUTH_URL: "http://localhost:3000",
								// tools.ts の buildAffiliateConfig が参照(未設定なら素の検索URL)
								RAKUTEN_AFFILIATE_ID: "",
								MOSHIMO_AMAZON_A_ID: "",
							},
						},
					}),
				],
				test: {
					name: "workers",
					include: ["src/**/*.workers.test.ts"],
					setupFiles: ["./test/apply-migrations.ts"],
				},
			},
		],
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
