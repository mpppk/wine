import { readFileSync } from "node:fs";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
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
//
// `wrangler d1 migrations apply` は drizzle/ の .sql を**連番規約に関係なく**適用する。
// ここで連番外を黙って除外すると「テストは緑なのに本番の apply では別のSQLも走る」状態に
// なるため、除外せず検出して落とす(#268)。連番外SQLの混入は #163 で実際に起きている。
const allMigrations = await readD1Migrations("./drizzle");
const nonSequential = allMigrations.filter((m) => !/^\d+_/.test(m.name));
if (nonSequential.length > 0) {
	throw new Error(
		`drizzle/ に連番規約(NNNN_*.sql)外のSQLがあります: ${nonSequential
			.map((m) => m.name)
			.join(", ")}\n` +
			"wrangler は連番外も適用するため、テストだけが実態と食い違います。" +
			"連番にリネームするか drizzle/ の外へ移動してください(docs/architecture.md)。",
	);
}
const migrations = allMigrations;

// compatibilityDate は wrangler.jsonc から読む。二重に手書きすると wrangler 側だけ
// 日付を上げたときにテストが旧ランタイム挙動のまま緑になる(#268)。
// jsonc なのでコメントを落としてから JSON.parse する。
const wranglerConfig = JSON.parse(
	readFileSync("./wrangler.jsonc", "utf8")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, ""),
) as { compatibility_date: string; compatibility_flags?: string[] };
const {
	compatibility_date: compatibilityDate,
	compatibility_flags: compatibilityFlags = [],
} = wranglerConfig;

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
							// wrangler.jsonc から読む(二重管理しない・#268)
							compatibilityDate,
							compatibilityFlags,
							d1Databases: ["DB"],
							r2Buckets: ["AVATARS"],
							// スロットル(#397)。**本番の上限値はあえて再現しない**。
							// 上限そのものは wrangler.jsonc の設定値であって、テストで
							// 数値を書き写しても設定を二重管理するだけになる。ここで
							// 検証したいのは「上限に達したら false を返し、経路がそれを
							// 拒否に写すか」なので、少ない回数で使い切れる値にする。
							// miniflare 側はバインディング名をキーにしたレコードで受ける
							// (wrangler.jsonc の配列形式とは形が違う)。
							ratelimits: {
								RATE_LIMIT_WRITE: {
									namespace_id: "9001",
									simple: { limit: 3, period: 10 },
								},
								RATE_LIMIT_UPLOAD: {
									namespace_id: "9002",
									simple: { limit: 3, period: 10 },
								},
								RATE_LIMIT_FETCH_TITLE: {
									namespace_id: "9003",
									simple: { limit: 3, period: 10 },
								},
							},
							bindings: {
								// setup(test/apply-migrations.ts)で適用するマイグレーション本体
								TEST_MIGRATIONS: migrations,
								// ハンドラが絶対URL(geojson_url/map_url等)を組むのに使う
								BETTER_AUTH_URL: "http://localhost:3000",
								// tools.ts の buildAffiliateConfig が参照(未設定なら素の検索URL)
								RAKUTEN_AFFILIATE_ID: "",
								MOSHIMO_AMAZON_A_ID: "",
								// 期間延長コード(billing-service の引換テスト用)。本番の値とは
								// 無関係で、書式(CODE=days)だけ合わせてある
								CAMPAIGN_EXTENSION_CODES: "TESTCODE=7",
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
