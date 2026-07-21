import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { AdBanner } from "../components/ads/AdBanner";
import { CommandPalette } from "../components/CommandPalette";
import { CommandPaletteProvider } from "../components/CommandPaletteContext";
import Header from "../components/Header";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

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
				title: "ワインAOP学習アプリ",
			},
			{
				name: "description",
				content: "ワインのAOP(原産地呼称)を地図で学ぶアプリ",
			},
			{
				name: "application-name",
				content: "ワインAOP学習アプリ",
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
				content: "ワインAOP学習アプリ",
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
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
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
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Static theme bootstrap script must run before hydration. */}
				<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
				<HeadContent />
			</head>
			<body className="font-sans antialiased [overflow-wrap:anywhere]">
				<CommandPaletteProvider>
					<Header />
					{children}
					<AdBanner />
					<CommandPalette />
				</CommandPaletteProvider>
				<Scripts />
			</body>
		</html>
	);
}
