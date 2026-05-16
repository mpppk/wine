import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getSession } from "#/server/auth";
import { createOrg, listOrgs } from "#/server/orgs";

export const Route = createFileRoute("/orgs")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: async ({ context }) => {
		await context.queryClient.prefetchQuery({
			queryKey: ["orgs"],
			queryFn: () => listOrgs(),
		});
	},
	component: OrgsPage,
});

function OrgsPage() {
	const { data: orgs, refetch } = useQuery({
		queryKey: ["orgs"],
		queryFn: () => listOrgs(),
	});

	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");

	const { mutate: handleCreate, isPending } = useMutation({
		mutationFn: () => createOrg({ data: { name, slug } }),
		onSuccess: () => {
			refetch();
			setName("");
			setSlug("");
		},
	});

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<h1 className="mb-6 text-2xl font-bold">Organizations</h1>

			<ul className="mb-8 space-y-2">
				{orgs?.map((org) => (
					<li key={org.id}>
						<Link
							to="/org/$orgId"
							params={{ orgId: org.id }}
							className="block rounded-lg border border-border px-4 py-3 transition-colors hover:bg-muted no-underline text-foreground"
						>
							{org.name}
						</Link>
					</li>
				))}
				{orgs?.length === 0 && (
					<li className="text-muted-foreground text-sm">
						No organizations yet.
					</li>
				)}
			</ul>

			<Card>
				<CardHeader>
					<CardTitle>Create Organization</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="org-name">Name</Label>
							<Input
								id="org-name"
								type="text"
								placeholder="My Organization"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="org-slug">Slug</Label>
							<Input
								id="org-slug"
								type="text"
								placeholder="my-org"
								value={slug}
								onChange={(e) => setSlug(e.target.value)}
							/>
						</div>
						<Button
							type="button"
							disabled={!name.trim() || !slug.trim() || isPending}
							onClick={() => handleCreate()}
						>
							Create
						</Button>
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
