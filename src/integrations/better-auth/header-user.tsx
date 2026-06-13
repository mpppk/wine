import { useRouter } from "@tanstack/react-router";
import { UserIcon } from "lucide-react";
import ThemeToggle from "#/components/ThemeToggle";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { authClient } from "#/lib/auth-client";

export default function BetterAuthHeader() {
	const { data: session, isPending } = authClient.useSession();
	const router = useRouter();

	if (isPending) {
		return (
			<div className="h-8 w-8 bg-neutral-100 dark:bg-neutral-800 animate-pulse rounded-full" />
		);
	}

	if (session?.user) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label="アカウントメニュー"
						className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{session.user.image ? (
							<img
								src={session.user.image}
								alt=""
								className="h-8 w-8 rounded-full object-cover hover:ring-2 hover:ring-ring transition-shadow"
							/>
						) : (
							<div className="h-8 w-8 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center hover:ring-2 hover:ring-ring transition-shadow">
								<span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
									{session.user.name?.charAt(0).toUpperCase() ?? "U"}
								</span>
							</div>
						)}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					<div className="flex items-center justify-between px-2 py-1.5">
						<span className="text-sm">ダークモード</span>
						<ThemeToggle />
					</div>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => {
							void router.navigate({ to: "/profile" });
						}}
					>
						プロフィールを編集
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={async () => {
							await authClient.signOut();
							void router.navigate({ to: "/login" });
						}}
					>
						Sign out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="アカウントメニュー"
					className="h-8 w-8 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center hover:ring-2 hover:ring-ring transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<UserIcon
						className="size-4 text-neutral-500 dark:text-neutral-400"
						aria-hidden
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<div className="flex items-center justify-between px-2 py-1.5">
					<span className="text-sm">ダークモード</span>
					<ThemeToggle />
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						void router.navigate({ to: "/login" });
					}}
				>
					Sign in
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
