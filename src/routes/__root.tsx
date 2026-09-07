import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { AdBanner } from "../components/ads/AdBanner";
import { CommandPalette } from "../components/CommandPalette";
import { CommandPaletteProvider } from "../components/CommandPaletteContext";
import Header from "../components/Header";
import { STARTER_GUIDE_INIT_SCRIPT } from "../lib/dashboard/guide-dismissal";
import { isEmbedPath } from "../lib/embed";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

// 保存値は 'light' | 'dark' の2値のみ(src/lib/theme.ts の ThemeMode が SSOT)。
// 未保存・不正値は OS の設定に従う。以前は 'auto' という第3の保存値も受け付けていたが、
// アプリはそれを書き込まないため到達しない分岐だった(#262)。
const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark')?stored:null;var resolved=mode||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode){root.setAttribute('data-theme',mode)}else{root.removeAttribute('data-theme')}root.style.colorScheme=resolved;}catch(e){}})();`;

// ハイドレーション前に localStorage を見て html の状態を整えるブートストラップ。
// テーマのFOUCと、閉じたスターターガイドのちらつきを防ぐ。どちらも「描画前に
// html へ印を付けて CSS 側で解決する」同じ形なので1つの script にまとめる。
const BOOT_SCRIPT = `${THEME_INIT_SCRIPT}${STARTER_GUIDE_INIT_SCRIPT}`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: m.app_title(),
			},
			{
				name: "description",
				content: m.app_description(),
			},
			{
				name: "application-name",
				content: m.app_title(),
			},
			{
				name: "mobile-web-app-capable",
				content: "yes",
			},
			{
				name: "apple-mobile-web-app-capable",
				content: "yes",
			},
			{
				name: "apple-mobile-web-app-status-bar-style",
				content: "default",
			},
			{
				name: "apple-mobile-web-app-title",
				content: m.app_title(),
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "manifest",
				href: "/manifest.json",
			},
			{
				rel: "icon",
				href: "/favicon.ico",
				sizes: "48x48",
			},
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg",
			},
			{
				rel: "apple-touch-icon",
				href: "/apple-touch-icon.png",
			},
		],
	}),
	// 全SSRページ共通のセキュリティレスポンスヘッダ(多層防御)。
	// - frame-ancestors 'none': 第三者サイトの iframe への埋め込みを禁止し、
	//   /oauth/consent(認可の Allow ボタン)等でのクリックジャッキングを防ぐ。
	//   X-Frame-Options より新しく、埋め込みを許可したい /embed/map では
	//   ルート単位で上書きできる(下位マッチのヘッダが後勝ちで優先される)。
	// - nosniff: HTML応答の MIME スニッフィングを抑止する。
	// - Referrer-Policy: クロスオリジン遷移時に参照元パスを送らない。
	headers: () => ({
		"Content-Security-Policy": "frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "strict-origin-when-cross-origin",
		// SSR HTML のメッセージ・lang・metadata は wine_locale Cookie に依存する。
		// キャッシュ層が追加されてもロケール違いのHTMLを混ぜない(#536)。
		Vary: "Cookie",
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	// MCP Apps ホストの iframe に埋め込むビューではアプリの共通シェルを出さない。
	// 見た目の問題だけでなく、これらのウィジェットはセッション・課金ステータスを
	// クライアントから取りに行くため、不透明オリジンの埋め込み先では必ず CORS で
	// 失敗して無駄なリトライを繰り返す(埋め込みビューは認証情報を使わない)。
	const isEmbed = useRouterState({
		select: (s) => isEmbedPath(s.location.pathname),
	});

	// Cookie で解決したロケールを document に反映し、スクリーンリーダーの言語も
	// 表示中のメッセージと揃える。Cookie 未設定時は従来どおり ja。
	return (
		<html lang={getLocale()} suppressHydrationWarning>
			<head>
				{/* theme-color is set as literal tags (not via head() meta) because
				    TanStack Router dedupes meta by name, dropping one of the two
				    prefers-color-scheme variants. */}
				<meta
					name="theme-color"
					content="#ffffff"
					media="(prefers-color-scheme: light)"
				/>
				<meta
					name="theme-color"
					content="#09090b"
					media="(prefers-color-scheme: dark)"
				/>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Static bootstrap script must run before hydration. */}
				<script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
				<HeadContent />
			</head>
			<body className="font-sans antialiased [overflow-wrap:anywhere]">
				{isEmbed ? (
					children
				) : (
					<CommandPaletteProvider>
						<Header />
						{children}
						<AdBanner />
						<CommandPalette />
					</CommandPaletteProvider>
				)}
				<Scripts />
			</body>
		</html>
	);
}
