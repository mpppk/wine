import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import * as authSchema from "#/db/auth-schema";

// Organization / team discovery for MCP tools. Todos are team-scoped and MCP
// clients have no "active" org/team (no cookie session), so an agent first
// lists the organizations and teams the user can access, then passes a team_id
// to the todo tools. Membership is read straight from the member/team tables.

// Organizations the user belongs to, with their membership role.
export async function listOrganizations(userId: string) {
	return db
		.select({
			id: authSchema.organization.id,
			name: authSchema.organization.name,
			slug: authSchema.organization.slug,
			role: authSchema.member.role,
		})
		.from(authSchema.member)
		.innerJoin(
			authSchema.organization,
			eq(authSchema.member.organizationId, authSchema.organization.id),
		)
		.where(eq(authSchema.member.userId, userId));
}

// Teams the user can access. Optionally scoped to a single organization; both
// paths verify the user is a member of every org whose teams are returned.
export async function listTeams(userId: string, orgId?: string) {
	if (orgId) {
		const [member] = await db
			.select({ id: authSchema.member.id })
			.from(authSchema.member)
			.where(
				and(
					eq(authSchema.member.organizationId, orgId),
					eq(authSchema.member.userId, userId),
				),
			)
			.limit(1);
		if (!member) {
			throw new Error("Forbidden: not a member of this organization");
		}
		return db
			.select({
				id: authSchema.team.id,
				name: authSchema.team.name,
				organizationId: authSchema.team.organizationId,
			})
			.from(authSchema.team)
			.where(eq(authSchema.team.organizationId, orgId));
	}

	// All teams across every organization the user is a member of.
	return db
		.select({
			id: authSchema.team.id,
			name: authSchema.team.name,
			organizationId: authSchema.team.organizationId,
		})
		.from(authSchema.team)
		.innerJoin(
			authSchema.member,
			eq(authSchema.member.organizationId, authSchema.team.organizationId),
		)
		.where(eq(authSchema.member.userId, userId));
}
