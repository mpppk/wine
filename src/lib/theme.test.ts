import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveInitialMode,
	STATUS_BAR_STYLES,
	setThemeMode,
	THEME_CHANGE_EVENT,
	THEME_COLORS,
	THEME_INIT_SCRIPT,
	type ThemeMode,
} from "./theme";

function mockMatchMedia(osDark: boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: query === "(prefers-color-scheme: dark)" ? osDark : false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	}));
}

// このリポジトリの jsdom 設定では window.localStorage が無いため、
// localStorage 依存の解決ロジック用にインメモリの代替を立てる。
function stubLocalStorage() {
	const store = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => {
				store.clear();
			},
		},
		configurable: true,
		writable: true,
	});
}

// __root.tsx のSSR直後の head を再現する。theme-color は TanStack の重複排除を
// 避けるため literal タグ2枚(media 付き)で出る。
function seedHead() {
	stubLocalStorage();
	document.head.innerHTML = [
		'<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">',
		'<meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">',
		'<meta name="apple-mobile-web-app-status-bar-style" content="default">',
	].join("");
	document.documentElement.className = "";
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.style.colorScheme = "";
	window.localStorage.clear();
}

function themeColorMetas() {
	return [...document.querySelectorAll('meta[name="theme-color"]')];
}

function singleThemeColor() {
	const metas = themeColorMetas();
	expect(metas).toHaveLength(1);
	const meta = metas[0];
	if (!meta) throw new Error("theme-color meta が無い");
	return meta;
}

function statusBarMeta() {
	return document.querySelector(
		'meta[name="apple-mobile-web-app-status-bar-style"]',
	);
}

describe("resolveInitialMode", () => {
	beforeEach(() => {
		seedHead();
	});

	it("保存値があればOSより優先する", () => {
		mockMatchMedia(true);
		window.localStorage.setItem("theme", "light");
		expect(resolveInitialMode()).toBe("light");
		window.localStorage.setItem("theme", "dark");
		expect(resolveInitialMode()).toBe("dark");
	});

	it("未保存・不正値はOSに従う", () => {
		mockMatchMedia(true);
		expect(resolveInitialMode()).toBe("dark");
		window.localStorage.setItem("theme", "auto");
		expect(resolveInitialMode()).toBe("dark");
		mockMatchMedia(false);
		window.localStorage.clear();
		expect(resolveInitialMode()).toBe("light");
	});
});

describe("setThemeMode", () => {
	beforeEach(() => {
		seedHead();
		mockMatchMedia(false);
	});

	it("dark指定でtheme-colorがダークに寄りmediaが外れる", () => {
		setThemeMode("dark");
		const meta = singleThemeColor();
		expect(meta.getAttribute("content")).toBe(THEME_COLORS.dark);
		expect(meta.hasAttribute("media")).toBe(false);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.dark,
		);
	});

	it("light指定でtheme-colorがライトに戻る", () => {
		setThemeMode("dark");
		setThemeMode("light");
		expect(singleThemeColor().getAttribute("content")).toBe(THEME_COLORS.light);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.light,
		);
	});

	it("アプリ内トグルがOSと食い違っても解決済みテーマが勝つ", () => {
		// OSはライトのまま、アプリだけダークにしたケース(PWA上部が白く残る報告)。
		mockMatchMedia(false);
		setThemeMode("dark");
		expect(singleThemeColor().getAttribute("content")).toBe(THEME_COLORS.dark);
	});

	it("テーマ変更イベントをdispatchする(__rootのhead追随用)", () => {
		const seen: ThemeMode[] = [];
		window.addEventListener(THEME_CHANGE_EVENT, (event) => {
			seen.push((event as CustomEvent<ThemeMode>).detail);
		});
		setThemeMode("dark");
		setThemeMode("light");
		expect(seen).toEqual(["dark", "light"]);
	});
});

describe("THEME_INIT_SCRIPT", () => {
	beforeEach(() => {
		seedHead();
	});

	function runBootScript() {
		new Function(THEME_INIT_SCRIPT)();
	}

	it("保存ダーク+OSライトでもペイント前にダークへ寄せる", () => {
		mockMatchMedia(false);
		window.localStorage.setItem("theme", "dark");
		runBootScript();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(singleThemeColor().getAttribute("content")).toBe(THEME_COLORS.dark);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.dark,
		);
	});

	it("未保存ならOSに従う", () => {
		mockMatchMedia(true);
		runBootScript();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(singleThemeColor().getAttribute("content")).toBe(THEME_COLORS.dark);
		mockMatchMedia(false);
		seedHead();
		runBootScript();
		expect(document.documentElement.classList.contains("light")).toBe(true);
		expect(singleThemeColor().getAttribute("content")).toBe(THEME_COLORS.light);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.light,
		);
	});
});
