import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "#/lib/auth-client";
import { createOrg, listOrgs } from "#/server/orgs";

export const Route = createFileRoute("/orgs")({
	beforeLoad: async () => {
		const session = await authClient.getSession();
		if (!session.data) {
			throw redirect({ to: "/" });
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
							className="block rounded-lg border px-4 py-3 hover:bg-muted transition-colors"
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

			<div className="rounded-lg border p-4">
				<h2 className="mb-3 font-semibold">Create Organization</h2>
				<div className="flex flex-col gap-2">
					<input
						type="text"
						placeholder="Name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="rounded border px-3 py-2 text-sm"
					/>
					<input
						type="text"
						placeholder="Slug (e.g. my-org)"
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
						className="rounded border px-3 py-2 text-sm"
					/>
					<button
						type="button"
						disabled={!name.trim() || !slug.trim() || isPending}
						onClick={() => handleCreate()}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
					>
						Create
					</button>
				</div>
			</div>
		</main>
	);
}
