import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { getSession } from "#/server/auth";
import {
	createTeam,
	inviteMember,
	listMembers,
	listTeams,
} from "#/server/orgs";

export const Route = createFileRoute("/org/$orgId/")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
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
				<Link to="/orgs" className="hover:text-foreground transition-colors">
					Organizations
				</Link>
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
							className="block rounded-lg border border-border px-4 py-3 transition-colors hover:bg-muted no-underline text-foreground"
						>
							{team.name}
						</Link>
					</li>
				))}
				{teams?.length === 0 && (
					<li className="text-muted-foreground text-sm">No teams yet.</li>
				)}
			</ul>

			<Card className="mb-8">
				<CardHeader>
					<CardTitle>Create Team</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex gap-2">
						<Input
							type="text"
							placeholder="Team name"
							value={teamName}
							onChange={(e) => setTeamName(e.target.value)}
							className="flex-1"
						/>
						<Button
							type="button"
							disabled={!teamName.trim() || creatingTeam}
							onClick={() => handleCreateTeam()}
						>
							Create
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Members</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<ul className="space-y-1 text-sm">
						{org?.members?.map((m) => (
							<li key={m.id} className="flex justify-between">
								<span>
									{m.user.name} ({m.user.email})
								</span>
								<span className="text-muted-foreground">{m.role}</span>
							</li>
						))}
					</ul>

					<div className="border-t border-border pt-4">
						<p className="mb-3 text-sm font-medium">Invite Member</p>
						<div className="flex flex-col gap-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="invite-email">Email</Label>
								<Input
									id="invite-email"
									type="email"
									placeholder="colleague@example.com"
									value={inviteEmail}
									onChange={(e) => setInviteEmail(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="invite-role">Role</Label>
								<Select
									value={inviteRole}
									onValueChange={(v) =>
										setInviteRole(v as "member" | "admin" | "owner")
									}
								>
									<SelectTrigger id="invite-role">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="member">Member</SelectItem>
										<SelectItem value="admin">Admin</SelectItem>
										<SelectItem value="owner">Owner</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<Button
								type="button"
								disabled={!inviteEmail.trim() || inviting}
								onClick={() => handleInvite()}
							>
								Send Invite
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
