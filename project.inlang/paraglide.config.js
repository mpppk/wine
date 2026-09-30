import { defineConfig } from "@inlang/paraglide-js";

// Paraglide のコンパイラ設定(i18n Phase 1 #536)。CLI(`bun run paraglide`)と
// vite プラグインの両方がここを読む(後者の明示オプションが勝つ)。
// strategy は ["cookie", "baseLocale"] で URL は分けない:
// 既定は cookie が無ければ ja(Accept-Language を見ない。SSR と
// ハイドレーションで解決結果がズレる余地を残さないため)。
export default defineConfig({
	outdir: "./src/paraglide",
	strategy: ["cookie", "baseLocale"],
	cookieName: "wine_locale",
	// tsconfig が allowJs を持たないため、生成物の型は .d.ts で受ける
	// (JSDoc 推論ではなく確実にエディタ・tscへ反映させる)。
	emitTsDeclarations: true,
});
