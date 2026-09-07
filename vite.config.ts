import { cloudflare } from "@cloudflare/vite-plugin";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Sentry へソースマップを上げるのは **SENTRY_AUTH_TOKEN がある環境だけ**(Issue #381)。
// トークンの有無でビルドの成否が変わってはならない: CI(トークン無し)でも
// `bun run build` / `check:deploy` が通り、Cloudflare Workers Builds(トークン有り)
// でだけアップロードが走る、という形にする。
//
// アップロード後にソースマップは dist から削除する。**公開配信すると誰でも
// クライアントの原文を読めてしまう**ため、Sentry に置くだけにする。
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const uploadsSourceMaps = Boolean(sentryAuthToken);

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// ソースマップはアップロードするときだけ生成する(常時生成はビルド時間と
	// 出力サイズをただ増やす)。"hidden" にするのは `//# sourceMappingURL=` の参照を
	// 出力に残さないため: アップロード後にマップは削除するので、参照だけが残ると
	// DevTools を開くたびに 404 を引く。Sentry 側の紐づけはバンドルへ埋め込まれる
	// debug ID で行われるので参照は不要。
	build: { sourcemap: uploadsSourceMaps ? "hidden" : false },
	plugins: [
		devtools(),
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			strategy: ["cookie", "baseLocale"],
			cookieName: "wine_locale",
			emitTsDeclarations: true,
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		...(uploadsSourceMaps
			? [
					sentryVitePlugin({
						org: process.env.SENTRY_ORG,
						project: process.env.SENTRY_PROJECT,
						authToken: sentryAuthToken,
						release: { name: process.env.VITE_SENTRY_RELEASE },
						// ビルド情報を Sentry へ送る既定の計測はオフにする(こちらから出す
						// データは収集イベントだけに限る)
						telemetry: false,
						// **アップロード後に必ず消す**。マップが dist に残ると静的アセットとして
						// 公開配信され、誰でもクライアントの原文を読めてしまう。アップロードが
						// 失敗した場合も削除される(症状は「そのリリースだけ復元できない」に留まり、
						// 公開されるより安全な側に倒れる)
						sourcemaps: {
							filesToDeleteAfterUpload: ["./dist/**/*.map"],
						},
					}),
				]
			: []),
	],
});

export default config;
