import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest uses its own config instead of the app's vite.config.ts so it does not
// load the Cloudflare / TanStack Start plugins. Those plugins configure a Worker
// (`ssr`) environment whose `resolve.external` is rejected by the Cloudflare
// plugin's validation when Vite resolves the config in a dev-server-like flow,
// which is exactly what Vitest does on startup.
const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [react()],
	test: {
		environment: "jsdom",
		passWithNoTests: true,
	},
});

export default config;
