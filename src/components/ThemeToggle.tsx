import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveInitialMode, setThemeMode, type ThemeMode } from "#/lib/theme";
import { cn } from "#/lib/utils";
import { Switch } from "./ui/switch";

export default function ThemeToggle() {
	const [mode, setMode] = useState<ThemeMode>("light");

	useEffect(() => {
		setMode(resolveInitialMode());
	}, []);

	function handleToggle(checked: boolean) {
		setMode(setThemeMode(checked ? "dark" : "light"));
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
