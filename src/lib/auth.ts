import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as authSchema from "#/db/auth-schema";

export const auth = betterAuth({
	database: drizzleAdapter(drizzle(env.DB), {
		provider: "sqlite",
		schema: authSchema,
	}),
	trustedOrigins: ["http://localhost:3000", "http://localhost:3001"],
	emailAndPassword: {
		enabled: true,
	},
	plugins: [
		tanstackStartCookies(),
		organization({
			teams: {
				enabled: true,
				defaultTeam: {
					enabled: false,
				},
			},
			sendInvitationEmail: async (_data) => {
				// TODO: implement email sending
			},
		}),
	],
});
