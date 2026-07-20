import { stripeClient } from "@better-auth/stripe/client";
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [
		// authClient.subscription.upgrade / list / cancel / restore / billingPortal
		stripeClient({ subscription: true }),
		// user テーブルの独自カラム(auth.ts の additionalFields と一致させる)を
		// session.user / updateUser に型付けする。
		inferAdditionalFields({
			user: { preferredAiModel: { type: "string", required: false } },
		}),
		// session.user.role / banned の型付けと、将来の authClient.admin.* 用。
		adminClient(),
	],
});
