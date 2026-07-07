import { eq } from "drizzle-orm";
import { db } from "#/db";
import { todos } from "#/db/schema";
import {
	assertOrgAdmin,
	assertTeamAccess,
	requireTodoWithAccess,
} from "./access";

// Todo CRUD shared by the web UI (src/server/todos.ts) and the MCP tools. Every
// function takes the acting userId explicitly and enforces the same permission
// model as the web UI: read = org member, write = org admin/owner.

export async function listTodos(userId: string, teamId: string) {
	await assertTeamAccess(teamId, userId);
	return db.select().from(todos).where(eq(todos.teamId, teamId));
}

export async function createTodo(
	userId: string,
	input: {
		teamId: string;
		title: string;
		description?: string | null;
		assigneeId?: string | null;
	},
) {
	const team = await assertTeamAccess(input.teamId, userId);
	await assertOrgAdmin(team.organizationId, userId);
	const [todo] = await db
		.insert(todos)
		.values({
			title: input.title,
			description: input.description ?? null,
			teamId: input.teamId,
			assigneeId: input.assigneeId ?? null,
		})
		.returning();
	return todo;
}

export async function updateTodo(
	userId: string,
	input: {
		todoId: number;
		title?: string;
		description?: string | null;
		done?: boolean;
		assigneeId?: string | null;
	},
) {
	const { team } = await requireTodoWithAccess(input.todoId, userId);
	await assertOrgAdmin(team.organizationId, userId);

	const updates: Partial<typeof todos.$inferInsert> = {};
	if (input.title !== undefined) updates.title = input.title;
	if (input.description !== undefined) updates.description = input.description;
	if (input.done !== undefined) updates.done = input.done;
	if (input.assigneeId !== undefined) updates.assigneeId = input.assigneeId;
	if (Object.keys(updates).length === 0) {
		throw new Error("Provide at least one field to update");
	}

	const [todo] = await db
		.update(todos)
		.set(updates)
		.where(eq(todos.id, input.todoId))
		.returning();
	return todo;
}

export async function deleteTodo(userId: string, todoId: number) {
	const { team } = await requireTodoWithAccess(todoId, userId);
	await assertOrgAdmin(team.organizationId, userId);
	await db.delete(todos).where(eq(todos.id, todoId));
	return { success: true };
}
