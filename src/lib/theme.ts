export type ThemeMode = "light" | "dark";

// PWA のステータスバー等が参照する色。__root.tsx の literal な theme-color タグと
// 同じ値にすること。manifest.json の theme_color/background_color(#ffffff 固定)は
// 今回触らない方針のため、meta 側だけをアプリテーマへ同期させる(#576)。
export const THEME_COLORS: Record<ThemeMode, string> = {
	light: "#ffffff",
	dark: "#09090b",
};

// iOS standalone のステータスバー。`default` は常に白系になるため、ダーク時は
// コンテンツに重ねる `black-translucent`(白文字)へ寄せる(#576)。
export const STATUS_BAR_STYLES: Record<ThemeMode, string> = {
	light: "default",
	dark: "black-translucent",
};

export function resolveInitialMode(): ThemeMode {
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
	syncHeadTheme(mode);
}

/**
 * 解決済みアプリテーマを head の meta へ反映する。
 * theme-color の literal タグは `media="(prefers-color-scheme: ...)"` 付きで
 * OS設定にしか追従しないため、アプリ内トグルと食い違うとPWA上部が白く残る
 * (#576)。先頭1枚へ解決色を書き込み media を外し、残りは除去して1枚に寄せる。
 * 書き込む値は __root.tsx の React 描画と同一のため、ハイドレーションの
 * 再利用と競合せず重複タグを生まない。何枚あっても1枚に畳むので冪等。
 */
function syncHeadTheme(mode: ThemeMode) {
	if (typeof document === "undefined") return;
	const metas = document.querySelectorAll('meta[name="theme-color"]');
	metas.forEach((meta, index) => {
		if (index === 0) {
			meta.setAttribute("content", THEME_COLORS[mode]);
			meta.removeAttribute("media");
		} else {
			meta.parentNode?.removeChild(meta);
		}
	});
	if (metas.length === 0) {
		const meta = document.createElement("meta");
		meta.setAttribute("name", "theme-color");
		meta.setAttribute("content", THEME_COLORS[mode]);
		document.head.appendChild(meta);
	}
	document
		.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
		?.setAttribute("content", STATUS_BAR_STYLES[mode]);
}

// 保存値は 'light' | 'dark' の2値のみ。未保存・不正値は OS の設定に従う。
// 以前は 'auto' という第3の保存値も受け付けていたが、アプリはそれを書き込まない
// ため到達しない分岐だった(#262)。
//
// ペイント前に実行するブートストラップスクリプト。__root.tsx が inline script
// として埋め込む。inline のため import できず、下の解決・同期ロジックは
// resolveInitialMode / syncHeadTheme と二重化している。変えたら両方を直し、
// src/lib/theme.test.ts で振る舞いを検証すること(#576)。
export const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark')?stored:null;var resolved=mode||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode){root.setAttribute('data-theme',mode)}else{root.removeAttribute('data-theme')}root.style.colorScheme=resolved;var tc=resolved==='dark'?'${THEME_COLORS.dark}':'${THEME_COLORS.light}';var tcs=document.querySelectorAll('meta[name="theme-color"]');if(tcs.length===0){var m=document.createElement('meta');m.setAttribute('name','theme-color');m.setAttribute('content',tc);document.head.appendChild(m)}for(var i=0;i<tcs.length;i++){if(i===0){tcs[i].setAttribute('content',tc);tcs[i].removeAttribute('media')}else if(tcs[i].parentNode){tcs[i].parentNode.removeChild(tcs[i])}}var sb=document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(sb){sb.setAttribute('content',resolved==='dark'?'${STATUS_BAR_STYLES.dark}':'${STATUS_BAR_STYLES.light}')}}catch(e){}})();`;

/** Applies the given mode, persists it to localStorage, and returns it. */
export function setThemeMode(mode: ThemeMode): ThemeMode {
	applyTheme(mode);
	window.localStorage.setItem("theme", mode);
	window.dispatchEvent(
		new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }),
	);
	return mode;
}

/**
 * setThemeMode が dispatch するイベント。__root.tsx が購読し、React 管理の
 * head meta を解決テーマへ寄せる。DOM を直接書き換える syncHeadTheme と
 * 同じ値を描くため、ハイドレーションの再利用と競合しない(#576)。
 */
export const THEME_CHANGE_EVENT = "wine-theme-change";
