import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { Switch } from "./ui/switch";

type ThemeMode = "light" | "dark";

function resolveInitialMode(): ThemeMode {
	if (typeof window === "undefined") return "light";
	const stored = window.localStorage.getItem("theme");
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyTheme(mode: ThemeMode) {
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(mode);
	root.setAttribute("data-theme", mode);
	root.style.colorScheme = mode;
}

export default function ThemeToggle() {
	const [mode, setMode] = useState<ThemeMode>("light");

	useEffect(() => {
		setMode(resolveInitialMode());
	}, []);

	function handleToggle(checked: boolean) {
		const next: ThemeMode = checked ? "dark" : "light";
		setMode(next);
		applyTheme(next);
		window.localStorage.setItem("theme", next);
	}

	const isDark = mode === "dark";
	const label = isDark ? "Switch to light mode" : "Switch to dark mode";

	return (
		<div className="flex items-center gap-1.5" title={label}>
			<SunIcon
				className={cn(
					"size-4 transition-opacity",
					isDark ? "opacity-40 text-muted-foreground" : "text-foreground",
				)}
				aria-hidden
			/>
			<Switch
				checked={isDark}
				onCheckedChange={handleToggle}
				aria-label={label}
			/>
			<MoonIcon
				className={cn(
					"size-4 transition-opacity",
					isDark ? "text-foreground" : "opacity-40 text-muted-foreground",
				)}
				aria-hidden
			/>
		</div>
	);
}
