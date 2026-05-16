import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { auth } from "#/lib/auth";
import { authMiddleware } from "#/server/middleware";

export const listOrgs = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async () => {
		const request = getRequest();
		return auth.api.listOrganizations({ headers: request.headers });
	});

export const createOrg = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({ name: z.string().min(1), slug: z.string().min(1) }),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.createOrganization({
			headers: request.headers,
			body: { name: data.name, slug: data.slug },
		});
	});

export const listTeams = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ orgId: z.string() }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.listOrganizationTeams({
			headers: request.headers,
			query: { organizationId: data.orgId },
		});
	});

export const createTeam = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ orgId: z.string(), name: z.string().min(1) }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.createTeam({
			headers: request.headers,
			body: { organizationId: data.orgId, name: data.name },
		});
	});

export const listMembers = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ orgId: z.string() }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.getFullOrganization({
			headers: request.headers,
			query: { organizationId: data.orgId },
		});
	});

export const inviteMember = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			orgId: z.string(),
			email: z.string().email(),
			role: z.enum(["member", "admin", "owner"]),
		}),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.createInvitation({
			headers: request.headers,
			body: {
				organizationId: data.orgId,
				email: data.email,
				role: data.role,
			},
		});
	});

export const getInvitation = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ invitationId: z.string() }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.getInvitation({
			headers: request.headers,
			query: { id: data.invitationId },
		});
	});

export const acceptInvitation = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ invitationId: z.string() }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.acceptInvitation({
			headers: request.headers,
			body: { invitationId: data.invitationId },
		});
	});

export const rejectInvitation = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ invitationId: z.string() }))
	.handler(async ({ data }) => {
		const request = getRequest();
		return auth.api.rejectInvitation({
			headers: request.headers,
			body: { invitationId: data.invitationId },
		});
	});
