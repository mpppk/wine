export type ThemeMode = "light" | "dark";

export function resolveInitialMode(): ThemeMode {
	if (typeof window === "undefined") return "light";
	const stored = window.localStorage.getItem("theme");
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function applyTheme(mode: ThemeMode) {
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(mode);
	root.setAttribute("data-theme", mode);
	root.style.colorScheme = mode;
}

/** Applies the given mode, persists it to localStorage, and returns it. */
export function setThemeMode(mode: ThemeMode): ThemeMode {
	applyTheme(mode);
	window.localStorage.setItem("theme", mode);
	return mode;
}
