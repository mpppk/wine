import { Link, useLocation } from "@tanstack/react-router";
import { SquareChevronRightIcon } from "lucide-react";
import { useCallback } from "react";
import BetterAuthHeader from "../integrations/better-auth/header-user.tsx";
import { isEmbedPath } from "../lib/embed";
import { ImpersonationBanner } from "./admin/ImpersonationBanner";
import { useCommandPalette } from "./CommandPaletteContext";
import { CreditBalanceIndicator } from "./credit/CreditBalanceIndicator";
import { Button } from "./ui/button";

export default function Header() {
	const { setOpen } = useCommandPalette();
	const pathname = useLocation({ select: (l) => l.pathname });
	// /embed/* はMCP Appsのiframeに埋め込まれるため、アプリのナビゲーションは出さない
	// (__root でも共通シェルごと外しているが、単体で使われた場合の保険として残す)
	const hidden = isEmbedPath(pathname);

	// 100dvh前提のページ(map.$regionId / cellar.map)がヘッダ分だけ縮めるよう、実測の
	// 高さをCSS変数で公開する(--ad-banner-height と同じ形)。px定数で引くと、なりすまし
	// 警告帯・ナビの折り返し・アイコンサイズの変更でヘッダが伸びた分だけドキュメントが
	// スクロール可能になり、ツールバー付近の余白をドラッグするとページ全体が動いてしまう。
	// ヘッダを描画しない経路(/embed/*)もあるので、要素の出入りに直接追従する ref
	// コールバックで張る(React 19 はコールバックの戻り値をクリーンアップに使う)。
	const setHeaderRef = useCallback((el: HTMLElement | null) => {
		if (!el) return;
		const root = document.documentElement;
		const ro = new ResizeObserver(() => {
			root.style.setProperty(
				"--header-height",
				`${el.getBoundingClientRect().height}px`,
			);
		});
		// border-box で観測する。既定の content-box だとパディングの変化でコールバックが
		// 発火せず、書き出す getBoundingClientRect().height(border box)とズレる。
		// edge-to-edge 時の pt-[env(safe-area-inset-top)] はまさにパディングなので、
		// content-box のままだとヘッダが伸びても --header-height が古いままになり、
		// 100dvh 前提のページが伸びた分だけスクロール可能になる(#607)。
		ro.observe(el, { box: "border-box" });
		return () => {
			ro.disconnect();
			root.style.removeProperty("--header-height");
		};
	}, []);

	if (hidden) {
		return null;
	}

	return (
		// pt-[env(safe-area-inset-top)] は edge-to-edge(viewport-fit=cover)時に、
		// ヘッダの背景をステータスバーの裏まで敷きつつ中身だけを下げるためのもの(#607)。
		// インセットが0の環境(デスクトップ・非対応ブラウザ)では 0px になるので見た目は
		// 変わらない。実測の --header-height はこのパディング込みで出るため、100dvh 前提の
		// ページ(map.$regionId / cellar.map)の高さ計算もそのまま追従する。
		<header
			ref={setHeaderRef}
			className="sticky top-0 z-50 border-b border-border bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-lg"
		>
			{/* なりすまし中のみ描画される警告帯(#116)。ヘッダーの内側に置くことで
			    スクロールしても常に見える(独立した sticky にすると top-0 を奪い合う)。 */}
			<ImpersonationBanner />
			<nav className="max-w-[1080px] mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:py-4">
				<Link
					to="/"
					className="flex-shrink-0 transition-opacity hover:opacity-80"
					aria-label="Wine AOP"
				>
					<img src="/favicon.svg" alt="" className="size-8 rounded-md" />
				</Link>

				<div className="ml-auto flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={() => setOpen(true)}
						aria-label="コマンドパレットを開く (⌘K)"
						title="コマンドパレットを開く (⌘K)"
					>
						<SquareChevronRightIcon className="size-4" aria-hidden />
					</Button>
					<CreditBalanceIndicator />
					<BetterAuthHeader />
				</div>
			</nav>
		</header>
	);
}
