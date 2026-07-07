import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { authClient } from "#/lib/auth-client";

type ConsentSearch = {
	consent_code?: string;
	client_id?: string;
	scope?: string;
};

// OAuth consent page. better-auth's mcp plugin redirects here (with a signed
// oidc_consent_prompt cookie) when an authorize request carries
// prompt=consent; POSTing the decision returns the client redirect URI.
export const Route = createFileRoute("/oauth/consent")({
	validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
		consent_code:
			typeof search.consent_code === "string" ? search.consent_code : undefined,
		client_id:
			typeof search.client_id === "string" ? search.client_id : undefined,
		scope: typeof search.scope === "string" ? search.scope : undefined,
	}),
	component: ConsentPage,
});

function ConsentPage() {
	const { consent_code, client_id, scope } = Route.useSearch();
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);

	const scopes = (scope ?? "").split(" ").filter(Boolean);

	const decide = async (accept: boolean) => {
		setError("");
		setSubmitting(accept ? "accept" : "deny");
		try {
			const { data, error: err } = await authClient.$fetch<{
				redirectURI?: string;
			}>("/oauth2/consent", {
				method: "POST",
				body: { accept, consent_code },
			});
			const redirectURI = (data as { redirectURI?: string } | null)
				?.redirectURI;
			if (err) {
				setError(err.message || "Failed to submit consent");
			} else if (redirectURI) {
				window.location.assign(redirectURI);
				return;
			} else if (accept) {
				setError("No redirect URI returned");
			} else {
				window.close();
			}
		} catch (_e) {
			setError("An unexpected error occurred");
		} finally {
			setSubmitting(null);
		}
	};

	if (!consent_code) {
		return (
			<div className="flex justify-center px-4 py-10">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>Invalid consent request</CardTitle>
						<CardDescription>
							This page must be opened from an authorization request.
						</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	return (
		<div className="flex justify-center px-4 py-10">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>Authorize application</CardTitle>
					<CardDescription>
						{client_id
							? `Client ${client_id} is requesting access to your account.`
							: "An application is requesting access to your account."}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{scopes.length > 0 && (
						<div>
							<p className="mb-2 text-sm font-medium">Requested scopes</p>
							<ul className="list-inside list-disc text-sm text-muted-foreground">
								{scopes.map((s) => (
									<li key={s}>{s}</li>
								))}
							</ul>
						</div>
					)}

					{error && (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
							<p className="text-sm text-destructive">{error}</p>
						</div>
					)}

					<div className="flex gap-3">
						<Button
							type="button"
							className="flex-1"
							disabled={submitting !== null}
							onClick={() => void decide(true)}
						>
							{submitting === "accept" ? "Please wait…" : "Allow"}
						</Button>
						<Button
							type="button"
							variant="outline"
							className="flex-1"
							disabled={submitting !== null}
							onClick={() => void decide(false)}
						>
							{submitting === "deny" ? "Please wait…" : "Deny"}
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
