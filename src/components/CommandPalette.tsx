import { useRouter } from "@tanstack/react-router";
import {
	FolderIcon,
	LogInIcon,
	LogOutIcon,
	SunMoonIcon,
	UserIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { authClient } from "#/lib/auth-client";
import { resolveInitialMode, setThemeMode } from "#/lib/theme";
import { useKeyboardInset } from "#/lib/useKeyboardInset";
import { useCommandPalette } from "./CommandPaletteContext";

const cmdkClassName =
	"[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5";

export function CommandPalette() {
	const { open, setOpen, commands } = useCommandPalette();
	const [search, setSearch] = useState("");
	const router = useRouter();
	const { data: session } = authClient.useSession();

	const keyboardInset = useKeyboardInset(open);
	// The selected command runs on close (via onCloseAutoFocus) so that a command
	// which focuses an element (e.g. "Todoを追加") wins over the dialog's focus
	// trap / focus-restore instead of being immediately stolen back.
	const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null);

	// Toggle with Cmd/Ctrl+K from anywhere in the app.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
				e.preventDefault();
				setOpen((v) => !v);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [setOpen]);

	useEffect(() => {
		if (open) setSearch("");
	}, [open]);

	const runAndClose = (fn: () => void | Promise<void>) => {
		pendingActionRef.current = fn;
		setOpen(false);
	};

	const toggleTheme = () => {
		const current = resolveInitialMode();
		setThemeMode(current === "dark" ? "light" : "dark");
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogHeader className="sr-only">
				<DialogTitle>コマンドパレット</DialogTitle>
				<DialogDescription>コマンドを検索して実行します。</DialogDescription>
			</DialogHeader>
			<DialogContent
				className="overflow-hidden p-0 max-sm:top-auto max-sm:bottom-[var(--cmdk-kb-inset)] max-sm:translate-y-0"
				style={
					{ "--cmdk-kb-inset": `${keyboardInset}px` } as React.CSSProperties
				}
				showCloseButton={false}
				onCloseAutoFocus={(e) => {
					const action = pendingActionRef.current;
					pendingActionRef.current = null;
					if (action) {
						// Let the command manage focus instead of restoring it to the trigger.
						e.preventDefault();
						void action();
					}
				}}
			>
				<Command className={cmdkClassName} loop>
					<CommandInput
						placeholder="コマンドを検索…"
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList>
						<CommandEmpty>該当するコマンドがありません。</CommandEmpty>

						{commands.length > 0 && (
							<CommandGroup heading="このページの操作">
								{commands.map((c) => (
									<CommandItem
										key={c.id}
										value={c.id}
										keywords={c.keywords}
										onSelect={() => runAndClose(c.onSelect)}
									>
										{c.icon}
										{c.label}
									</CommandItem>
								))}
							</CommandGroup>
						)}

						<CommandGroup heading="移動">
							<CommandItem
								keywords={["organizations", "組織", "一覧", "orgs"]}
								onSelect={() =>
									runAndClose(() => {
										void router.navigate({ to: "/orgs" });
									})
								}
							>
								<FolderIcon />
								組織一覧へ移動
							</CommandItem>

							{session?.user && (
								<CommandItem
									keywords={["profile", "プロフィール", "設定", "アカウント"]}
									onSelect={() =>
										runAndClose(() => {
											void router.navigate({ to: "/profile" });
										})
									}
								>
									<UserIcon />
									プロフィールを編集
								</CommandItem>
							)}

							<CommandItem
								keywords={[
									"theme",
									"dark",
									"light",
									"ダークモード",
									"テーマ",
									"切替",
								]}
								onSelect={() => runAndClose(toggleTheme)}
							>
								<SunMoonIcon />
								ダークモード切り替え
							</CommandItem>

							{session?.user ? (
								<CommandItem
									keywords={["signout", "logout", "サインアウト", "ログアウト"]}
									onSelect={() =>
										runAndClose(async () => {
											await authClient.signOut();
											void router.navigate({ to: "/login" });
										})
									}
								>
									<LogOutIcon />
									サインアウト
								</CommandItem>
							) : (
								<CommandItem
									keywords={["signin", "login", "サインイン", "ログイン"]}
									onSelect={() =>
										runAndClose(() => {
											void router.navigate({ to: "/login" });
										})
									}
								>
									<LogInIcon />
									サインイン
								</CommandItem>
							)}
						</CommandGroup>
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
