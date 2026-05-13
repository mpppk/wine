import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "#/lib/auth-client";
import {
	createTeam,
	inviteMember,
	listMembers,
	listTeams,
} from "#/server/orgs";

export const Route = createFileRoute("/org/$orgId/")({
	beforeLoad: async () => {
		const session = await authClient.getSession();
		if (!session.data) {
			throw redirect({ to: "/" });
		}
	},
	loader: async ({ context, params }) => {
		await Promise.all([
			context.queryClient.prefetchQuery({
				queryKey: ["teams", params.orgId],
				queryFn: () => listTeams({ data: { orgId: params.orgId } }),
			}),
			context.queryClient.prefetchQuery({
				queryKey: ["org-members", params.orgId],
				queryFn: () => listMembers({ data: { orgId: params.orgId } }),
			}),
		]);
	},
	component: OrgPage,
});

function OrgPage() {
	const { orgId } = Route.useParams();

	const { data: teams, refetch: refetchTeams } = useQuery({
		queryKey: ["teams", orgId],
		queryFn: () => listTeams({ data: { orgId } }),
	});

	const { data: org, refetch: refetchMembers } = useQuery({
		queryKey: ["org-members", orgId],
		queryFn: () => listMembers({ data: { orgId } }),
	});

	const [teamName, setTeamName] = useState("");
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<"member" | "admin" | "owner">(
		"member",
	);

	const { mutate: handleCreateTeam, isPending: creatingTeam } = useMutation({
		mutationFn: () => createTeam({ data: { orgId, name: teamName } }),
		onSuccess: () => {
			refetchTeams();
			setTeamName("");
		},
	});

	const { mutate: handleInvite, isPending: inviting } = useMutation({
		mutationFn: () =>
			inviteMember({ data: { orgId, email: inviteEmail, role: inviteRole } }),
		onSuccess: () => {
			refetchMembers();
			setInviteEmail("");
		},
	});

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
				<Link to="/orgs">Organizations</Link>
				<span>/</span>
				<span className="font-medium text-foreground">
					{org?.name ?? orgId}
				</span>
			</div>

			<h1 className="mb-6 text-2xl font-bold">Teams</h1>

			<ul className="mb-8 space-y-2">
				{teams?.map((team) => (
					<li key={team.id}>
						<Link
							to="/org/$orgId/team/$teamId/todos"
							params={{ orgId, teamId: team.id }}
							className="block rounded-lg border px-4 py-3 hover:bg-muted transition-colors"
						>
							{team.name}
						</Link>
					</li>
				))}
				{teams?.length === 0 && (
					<li className="text-muted-foreground text-sm">No teams yet.</li>
				)}
			</ul>

			<div className="mb-8 rounded-lg border p-4">
				<h2 className="mb-3 font-semibold">Create Team</h2>
				<div className="flex gap-2">
					<input
						type="text"
						placeholder="Team name"
						value={teamName}
						onChange={(e) => setTeamName(e.target.value)}
						className="flex-1 rounded border px-3 py-2 text-sm"
					/>
					<button
						type="button"
						disabled={!teamName.trim() || creatingTeam}
						onClick={() => handleCreateTeam()}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
					>
						Create
					</button>
				</div>
			</div>

			<div className="rounded-lg border p-4">
				<h2 className="mb-3 font-semibold">Members</h2>
				<ul className="mb-4 space-y-1 text-sm">
					{org?.members?.map((m) => (
						<li key={m.id} className="flex justify-between">
							<span>
								{m.user.name} ({m.user.email})
							</span>
							<span className="text-muted-foreground">{m.role}</span>
						</li>
					))}
				</ul>
				<h3 className="mb-2 text-sm font-medium">Invite Member</h3>
				<div className="flex flex-col gap-2">
					<input
						type="email"
						placeholder="Email"
						value={inviteEmail}
						onChange={(e) => setInviteEmail(e.target.value)}
						className="rounded border px-3 py-2 text-sm"
					/>
					<select
						value={inviteRole}
						onChange={(e) =>
							setInviteRole(e.target.value as "member" | "admin" | "owner")
						}
						className="rounded border px-3 py-2 text-sm"
					>
						<option value="member">Member</option>
						<option value="admin">Admin</option>
						<option value="owner">Owner</option>
					</select>
					<button
						type="button"
						disabled={!inviteEmail.trim() || inviting}
						onClick={() => handleInvite()}
						className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
					>
						Send Invite
					</button>
				</div>
			</div>
		</main>
	);
}
