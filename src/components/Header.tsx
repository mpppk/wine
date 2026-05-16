import { Link } from "@tanstack/react-router";
import BetterAuthHeader from "../integrations/better-auth/header-user.tsx";
import ThemeToggle from "./ThemeToggle";

export default function Header() {
	return (
		<header className="sticky top-0 z-50 border-b border-border bg-background/80 px-4 backdrop-blur-lg">
			<nav className="max-w-[1080px] mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:py-4">
				<Link
					to="/orgs"
					className="flex-shrink-0 text-sm font-semibold text-foreground no-underline transition-colors hover:text-foreground/80"
				>
					TODO App
				</Link>

				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold">
					<Link
						to="/orgs"
						className="relative text-muted-foreground no-underline transition-colors hover:text-foreground [&.active]:text-foreground"
						activeProps={{ className: "active" }}
					>
						Organizations
					</Link>
				</div>

				<div className="ml-auto flex items-center gap-2">
					<ThemeToggle />
					<BetterAuthHeader />
				</div>
			</nav>
		</header>
	);
}
