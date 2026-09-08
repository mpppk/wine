import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdBanner } from "../components/ads/AdBanner";
import { CommandPalette } from "../components/CommandPalette";
import { CommandPaletteProvider } from "../components/CommandPaletteContext";
import Header from "../components/Header";
import { STARTER_GUIDE_INIT_SCRIPT } from "../lib/dashboard/guide-dismissal";
import { isEmbedPath } from "../lib/embed";
import {
	resolveInitialMode,
	STATUS_BAR_STYLES,
	THEME_CHANGE_EVENT,
	THEME_COLORS,
	THEME_INIT_SCRIPT,
	type ThemeMode,
} from "../lib/theme";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

// ハイドレーション前に localStorage を見て html の状態を整えるブートストラップ。
// テーマのFOUCと、閉じたスターターガイドのちらつきを防ぐ。どちらも「描画前に
// html へ印を付けて CSS 側で解決する」同じ形なので1つの script にまとめる。
// THEME_INIT_SCRIPT は解決済みテーマへの theme-color 同期まで含む(src/lib/theme.ts)。
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
	// MCP Apps ホストの iframe に埋め込むビューではアプリの共通シェルを出さない。
	// 見た目の問題だけでなく、これらのウィジェットはセッション・課金ステータスを
	// クライアントから取りに行くため、不透明オリジンの埋め込み先では必ず CORS で
	// 失敗して無駄なリトライを繰り返す(埋め込みビューは認証情報を使わない)。
	const isEmbed = useRouterState({
		select: (s) => isEmbedPath(s.location.pathname),
	});

	// head meta が参照する解決済みテーマ。SSR 時は localStorage を読めないため
	// null で2タグfallback(No-JS 用)を出し、クライアント初回描画で解決済み単一
	// タグへ寄せる。描く値は THEME_INIT_SCRIPT のピン留めと同一のため、
	// ハイドレーションの再利用と競合せず重複タグを生まない。トグル時は
	// setThemeMode のイベントで追随する(#576)。
	const [headMode, setHeadMode] = useState<ThemeMode | null>(() =>
		typeof window === "undefined" ? null : resolveInitialMode(),
	);
	useEffect(() => {
		const onThemeChange = (event: Event) => {
			setHeadMode((event as CustomEvent<ThemeMode>).detail);
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
		return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
	}, []);

	// UI・meta description とも全編日本語なので lang も ja。en のままだと
	// スクリーンリーダーが英語TTSで日本語を読もうとして破綻する(#236)
	return (
		<html lang="ja" suppressHydrationWarning>
			<head>
				{/* theme-color / status-bar-style は literal タグで出す(head() meta は
				    TanStack Router が name で重複排除し2枚目の media 違いを落とす)。
				    apple-mobile-web-app-status-bar-style も単一情報源のため shell 側
				    のみで描く(#576)。 */}
				{headMode === null ? (
					<>
						<meta
							name="theme-color"
							content={THEME_COLORS.light}
							media="(prefers-color-scheme: light)"
						/>
						<meta
							name="theme-color"
							content={THEME_COLORS.dark}
							media="(prefers-color-scheme: dark)"
						/>
						<meta
							name="apple-mobile-web-app-status-bar-style"
							content={STATUS_BAR_STYLES.light}
						/>
					</>
				) : (
					<>
						<meta name="theme-color" content={THEME_COLORS[headMode]} />
						<meta
							name="apple-mobile-web-app-status-bar-style"
							content={STATUS_BAR_STYLES[headMode]}
						/>
					</>
				)}
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
