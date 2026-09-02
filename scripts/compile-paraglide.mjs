import { compile } from "@inlang/paraglide-js";

await compile({
	project: "./project.inlang",
	outdir: "./src/paraglide",
	strategy: ["cookie", "baseLocale"],
	cookieName: "wine_locale",
	emitTsDeclarations: true,
});
