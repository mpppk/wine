import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { getSession } from "#/server/auth";
import {
	acceptInvitation,
	getInvitation,
	rejectInvitation,
} from "#/server/orgs";

export const Route = createFileRoute("/accept-invitation")({
	validateSearch: (search) => z.object({ id: z.string() }).parse(search),
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loaderDeps: ({ search: { id } }) => ({ id }),
	loader: async ({ deps: { id } }) => {
		return getInvitation({ data: { invitationId: id } });
	},
	errorComponent: ({ error }) => (
		<main className="flex min-h-[calc(100vh-57px)] items-center justify-center px-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-2xl">Invitation Error</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-destructive">
						{error instanceof Error
							? error.message
							: "This invitation is invalid or has expired."}
					</p>
				</CardContent>
			</Card>
		</main>
	),
	component: AcceptInvitationPage,
});

function AcceptInvitationPage() {
	const router = useRouter();
	const invitation = Route.useLoaderData();
	const { id: invitationId } = Route.useSearch();
	const [error, setError] = useState("");

	const { mutate: handleAccept, isPending: accepting } = useMutation({
		mutationFn: () => acceptInvitation({ data: { invitationId } }),
		onSuccess: () => {
			router.navigate({
				to: "/org/$orgId",
				params: { orgId: invitation.organizationId },
			});
		},
		onError: (err) => {
			setError(
				err instanceof Error ? err.message : "Failed to accept invitation.",
			);
		},
	});

	const { mutate: handleReject, isPending: rejecting } = useMutation({
		mutationFn: () => rejectInvitation({ data: { invitationId } }),
		onSuccess: () => {
			router.navigate({ to: "/orgs" });
		},
		onError: (err) => {
			setError(
				err instanceof Error ? err.message : "Failed to decline invitation.",
			);
		},
	});

	const isPending = accepting || rejecting;

	return (
		<main className="flex min-h-[calc(100vh-57px)] items-center justify-center px-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-2xl">You've been invited</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-3 text-sm">
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground">Organization</span>
						<span className="font-medium">{invitation.organizationId}</span>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground">Role</span>
						<span className="font-medium capitalize">{invitation.role}</span>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground">Invited email</span>
						<span className="font-medium">{invitation.email}</span>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
				</CardContent>
				<CardFooter className="flex gap-2">
					<Button
						className="flex-1"
						disabled={isPending}
						onClick={() => handleAccept()}
					>
						{accepting ? "Accepting..." : "Accept"}
					</Button>
					<Button
						variant="outline"
						className="flex-1"
						disabled={isPending}
						onClick={() => handleReject()}
					>
						{rejecting ? "Declining..." : "Decline"}
					</Button>
				</CardFooter>
			</Card>
		</main>
	);
}
