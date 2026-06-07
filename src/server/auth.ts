import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";

export const getSession = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		return auth.api.getSession({ headers: request.headers });
	},
);

export type LastVisitedDestination =
	| { type: "team"; orgId: string; teamId: string }
	| { type: "org"; orgId: string }
	| { type: "orgs" };

export const getLastVisitedDestination = createServerFn({
	method: "GET",
}).handler(async (): Promise<LastVisitedDestination> => {
	const request = getRequest();
	const headers = request.headers;

	const session = await auth.api.getSession({ headers });
	const activeOrganizationId = session?.session.activeOrganizationId;
	if (!activeOrganizationId) {
		return { type: "orgs" };
	}

	const orgs = await auth.api.listOrganizations({ headers });
	if (!orgs.some((org) => org.id === activeOrganizationId)) {
		return { type: "orgs" };
	}

	const activeTeamId = session?.session.activeTeamId;
	if (activeTeamId) {
		const teams = await auth.api.listOrganizationTeams({
			headers,
			query: { organizationId: activeOrganizationId },
		});
		if (teams.some((team) => team.id === activeTeamId)) {
			return {
				type: "team",
				orgId: activeOrganizationId,
				teamId: activeTeamId,
			};
		}
	}

	return { type: "org", orgId: activeOrganizationId };
});
