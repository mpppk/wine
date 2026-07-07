import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as authSchema from "#/db/auth-schema";

export const auth = betterAuth({
	database: drizzleAdapter(drizzle(env.DB), {
		provider: "sqlite",
		schema: authSchema,
	}),
	trustedOrigins: [
		"http://localhost:3000",
		"http://localhost:3001",
		"https://wine.niboshi.workers.dev",
		"https://*.wine.niboshi.workers.dev",
	],
	emailAndPassword: {
		enabled: true,
	},
	plugins: [
		// OAuth 2.1 provider for MCP clients (Claude Code / Desktop etc.).
		mcp({
			loginPage: "/login",
			oidcConfig: {
				loginPage: "/login",
				consentPage: "/oauth/consent",
				// MCP clients register themselves via RFC 7591 dynamic registration.
				allowDynamicClientRegistration: true,
			},
		}),
		// The cookie integration must be last so Set-Cookie headers from the
		// plugins above (e.g. the mcp consent flow) are forwarded to TanStack.
		tanstackStartCookies(),
	],
});
