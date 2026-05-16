import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { todos } from "#/db/schema";
import { auth } from "#/lib/auth";
import { authMiddleware } from "#/server/middleware";

async function getOrgMember(orgId: string, userId: string) {
	const request = getRequest();
	const org = await auth.api.getFullOrganization({
		headers: request.headers,
		query: { organizationId: orgId },
	});
	if (!org) throw new Error("Organization not found");
	return org.members.find((m) => m.userId === userId) ?? null;
}

async function requireOrgMember(orgId: string, userId: string) {
	const member = await getOrgMember(orgId, userId);
	if (!member) throw new Error("Forbidden: not a member of this organization");
	return member;
}

async function requireOrgAdmin(orgId: string, userId: string) {
	const member = await requireOrgMember(orgId, userId);
	if (member.role !== "admin" && member.role !== "owner") {
		throw new Error("Forbidden: admin or owner required");
	}
	return member;
}

export const listTodos = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ teamId: z.string(), orgId: z.string() }))
	.handler(async ({ data, context }) => {
		await requireOrgMember(data.orgId, context.user.id);
		return db.select().from(todos).where(eq(todos.teamId, data.teamId));
	});

export const createTodo = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			orgId: z.string(),
			teamId: z.string(),
			title: z.string().min(1),
			description: z.string().optional(),
			assigneeId: z.string().optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		await requireOrgAdmin(data.orgId, context.user.id);
		const [todo] = await db
			.insert(todos)
			.values({
				title: data.title,
				description: data.description ?? null,
				teamId: data.teamId,
				assigneeId: data.assigneeId ?? null,
			})
			.returning();
		return todo;
	});

export const updateTodo = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(
		z.object({
			orgId: z.string(),
			todoId: z.number(),
			title: z.string().min(1).optional(),
			description: z.string().optional(),
			done: z.boolean().optional(),
			assigneeId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		await requireOrgAdmin(data.orgId, context.user.id);
		const { orgId: _orgId, todoId, ...fields } = data;
		const updates: Partial<typeof todos.$inferInsert> = {};
		if (fields.title !== undefined) updates.title = fields.title;
		if (fields.description !== undefined)
			updates.description = fields.description;
		if (fields.done !== undefined) updates.done = fields.done;
		if ("assigneeId" in fields) updates.assigneeId = fields.assigneeId ?? null;

		const [todo] = await db
			.update(todos)
			.set(updates)
			.where(eq(todos.id, todoId))
			.returning();
		return todo;
	});

export const deleteTodo = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ orgId: z.string(), todoId: z.number() }))
	.handler(async ({ data, context }) => {
		await requireOrgAdmin(data.orgId, context.user.id);
		await db.delete(todos).where(eq(todos.id, data.todoId));
		return { success: true };
	});
