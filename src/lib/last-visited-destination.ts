import type { LastVisitedDestination } from "#/server/auth";

export function toNavigateOptions(destination: LastVisitedDestination) {
	switch (destination.type) {
		case "team":
			return {
				to: "/org/$orgId/team/$teamId/todos",
				params: { orgId: destination.orgId, teamId: destination.teamId },
			} as const;
		case "org":
			return {
				to: "/org/$orgId",
				params: { orgId: destination.orgId },
			} as const;
		case "orgs":
			return { to: "/orgs" } as const;
	}
}
