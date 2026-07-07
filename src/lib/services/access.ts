import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import * as authSchema from "#/db/auth-schema";
import { todos } from "#/db/schema";

// Authorization helpers shared by server functions and MCP tools. Unlike the
// in-request helpers in src/server/todos.ts these take the acting userId
// explicitly and never touch the request context, so they work outside a
// browser session (e.g. for OAuth bearer tokens from MCP clients).

// Verify the user is a member of the organization by querying the membership
// table directly (equivalent to the members check previously done through
// auth.api.getFullOrganization, which required session headers).
export async function assertOrgMember(
	orgId: string,
	userId: string,
): Promise<void> {
	const [row] = await db
		.select({ id: authSchema.member.id })
		.from(authSchema.member)
		.where(
			and(
				eq(authSchema.member.organizationId, orgId),
				eq(authSchema.member.userId, userId),
			),
		)
		.limit(1);
	if (!row) throw new Error("Forbidden: not a member of this organization");
}

// Verify the user is an admin or owner of the organization (required for
// writes, mirroring the existing web UI restriction).
export async function assertOrgAdmin(
	orgId: string,
	userId: string,
): Promise<void> {
	const [row] = await db
		.select({ role: authSchema.member.role })
		.from(authSchema.member)
		.where(
			and(
				eq(authSchema.member.organizationId, orgId),
				eq(authSchema.member.userId, userId),
			),
		)
		.limit(1);
	if (!row) throw new Error("Forbidden: not a member of this organization");
	if (row.role !== "admin" && row.role !== "owner") {
		throw new Error("Forbidden: admin or owner required");
	}
}

// Resolve a team and verify the user can access it (org member).
export async function assertTeamAccess(teamId: string, userId: string) {
	const [team] = await db
		.select()
		.from(authSchema.team)
		.where(eq(authSchema.team.id, teamId));
	if (!team) throw new Error("Team not found");
	await assertOrgMember(team.organizationId, userId);
	return team;
}

// Resolve a todo and its owning team/org. Used by update/delete tools which
// only receive a todo_id: the org is derived here so admin/owner can be
// enforced.
export async function requireTodoWithAccess(todoId: number, userId: string) {
	const [todo] = await db.select().from(todos).where(eq(todos.id, todoId));
	if (!todo) throw new Error("Todo not found");
	const team = await assertTeamAccess(todo.teamId, userId);
	return { todo, team };
}
