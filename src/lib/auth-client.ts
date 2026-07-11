import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	// authClient.subscription.upgrade / list / cancel / restore / billingPortal
	plugins: [stripeClient({ subscription: true })],
});
