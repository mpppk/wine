import { Link, useLocation } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "#/components/ui/button";
import { isAdBannerPath } from "#/lib/ads/placement";
import { useShowAds } from "#/lib/billing/use-billing";

// 学習系ページの画面下部に固定表示するハウス広告バナー(現状はプレミアム訴求のみ)。
// 実広告ネットワークを導入する場合はこの枠の中身を差し替える。
// 表示可否は「ユーザー判定(useShowAds)」×「ページ判定(isAdBannerPath)」の二段構え。

/** バナーの高さ。spacer・固定バナー・--ad-banner-height の3箇所で共有する。 */
const BANNER_HEIGHT = "calc(3.5rem + env(safe-area-inset-bottom))";

export function AdBanner() {
	const pathname = useLocation({ select: (l) => l.pathname });
	const visible = useShowAds() && isAdBannerPath(pathname);

	// 100dvh前提の地図ページ(map.$regionId / cellar.map)がバナー分だけ縮むよう、
	// 表示中はCSS変数で高さを公開する(未定義時は各ページ側で0pxにフォールバック)
	useEffect(() => {
		if (!visible) return;
		const root = document.documentElement;
		root.style.setProperty("--ad-banner-height", BANNER_HEIGHT);
		return () => {
			root.style.removeProperty("--ad-banner-height");
		};
	}, [visible]);

	if (!visible) return null;

	return (
		<>
			{/* 固定バナーに隠れる分のスクロール余白を通常フローの末尾に確保する */}
			<div
				aria-hidden
				className="h-[calc(3.5rem+env(safe-area-inset-bottom))]"
			/>
			<div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
				<div className="mx-auto flex h-14 max-w-[1080px] items-center gap-3 px-4">
					<span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
						広告
					</span>
					<p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
						<SparklesIcon
							className="mr-1 inline size-4 align-[-0.2em] text-primary"
							aria-hidden
						/>
						プレミアムなら広告なし
						{/* モバイル幅では途中で切れて意味が通らないため後半は sm 以上のみ */}
						<span className="hidden sm:inline">で快適に学習できます</span>
					</p>
					<Button asChild size="sm" variant="outline" className="shrink-0">
						<Link to="/pricing">詳しく見る</Link>
					</Button>
				</div>
			</div>
		</>
	);
}
