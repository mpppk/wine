import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveInitialMode,
	setThemeMode,
	STATUS_BAR_STYLES,
	THEME_COLORS,
	THEME_INIT_SCRIPT,
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

// __root.tsx のSSR直後の head を再現する。theme-color は TanStack の重複排除を
// 避けるため literal タグ2枚(media 付き)で出る。
function seedHead() {
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
		const metas = themeColorMetas();
		expect(metas).toHaveLength(1);
		expect(metas[0].getAttribute("content")).toBe(THEME_COLORS.dark);
		expect(metas[0].hasAttribute("media")).toBe(false);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.dark,
		);
	});

	it("light指定でtheme-colorがライトに戻る", () => {
		setThemeMode("dark");
		setThemeMode("light");
		const metas = themeColorMetas();
		expect(metas).toHaveLength(1);
		expect(metas[0].getAttribute("content")).toBe(THEME_COLORS.light);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.light,
		);
	});

	it("アプリ内トグルがOSと食い違っても解決済みテーマが勝つ", () => {
		// OSはライトのまま、アプリだけダークにしたケース(PWA上部が白く残る報告)。
		mockMatchMedia(false);
		setThemeMode("dark");
		expect(themeColorMetas()[0].getAttribute("content")).toBe(
			THEME_COLORS.dark,
		);
	});
});

describe("THEME_INIT_SCRIPT", () => {
	beforeEach(() => {
		seedHead();
	});

	function runBootScript() {
		// biome-ignore lint/security/noGlobalEval: テスト対象のinlineブートスクリプト自体を実行する
		new Function(THEME_INIT_SCRIPT)();
	}

	it("保存ダーク+OSライトでもペイント前にダークへ寄せる", () => {
		mockMatchMedia(false);
		window.localStorage.setItem("theme", "dark");
		runBootScript();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		const metas = themeColorMetas();
		expect(metas).toHaveLength(1);
		expect(metas[0].getAttribute("content")).toBe(THEME_COLORS.dark);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.dark,
		);
	});

	it("未保存ならOSに従う", () => {
		mockMatchMedia(true);
		runBootScript();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(themeColorMetas()[0].getAttribute("content")).toBe(
			THEME_COLORS.dark,
		);
		mockMatchMedia(false);
		seedHead();
		runBootScript();
		expect(document.documentElement.classList.contains("light")).toBe(true);
		expect(themeColorMetas()[0].getAttribute("content")).toBe(
			THEME_COLORS.light,
		);
		expect(statusBarMeta()?.getAttribute("content")).toBe(
			STATUS_BAR_STYLES.light,
		);
	});
});
