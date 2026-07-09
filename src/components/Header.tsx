import { Link, useLocation } from "@tanstack/react-router";
import { SquareChevronRightIcon } from "lucide-react";
import BetterAuthHeader from "../integrations/better-auth/header-user.tsx";
import { useCommandPalette } from "./CommandPaletteContext";
import { Button } from "./ui/button";

export default function Header() {
	const { setOpen } = useCommandPalette();
	const pathname = useLocation({ select: (l) => l.pathname });

	// /embed/* はMCP Appsのiframeに埋め込まれるため、アプリのナビゲーションは出さない
	if (pathname.startsWith("/embed")) {
		return null;
	}

	return (
		<header className="sticky top-0 z-50 border-b border-border bg-background/80 px-4 backdrop-blur-lg">
			<nav className="max-w-[1080px] mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:py-4">
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
					<BetterAuthHeader />
				</div>
			</nav>
		</header>
	);
}
