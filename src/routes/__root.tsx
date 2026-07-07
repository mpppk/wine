import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
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
				title: "TODO App",
			},
			{
				name: "description",
				content: "タスクを管理できるTODOアプリ",
			},
			{
				name: "application-name",
				content: "TODO App",
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
				content: "TODO",
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
					<CommandPalette />
				</CommandPaletteProvider>
				<Scripts />
			</body>
		</html>
	);
}
