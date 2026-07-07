import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as todoService from "#/lib/services/todo-service";
import { authMiddleware } from "#/server/middleware";

// Thin wrappers over the shared todo service (src/lib/services/todo-service.ts).
// The service is keyed on the acting userId and enforces the permission model
// (read = org member, write = org admin/owner), so it is shared with the MCP
// tools. orgId is accepted for backwards compatibility with the UI callers but
// the owning org is derived from the team/todo inside the service.

export const listTodos = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ teamId: z.string(), orgId: z.string() }))
	.handler(async ({ data, context }) => {
		return todoService.listTodos(context.user.id, data.teamId);
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
		return todoService.createTodo(context.user.id, {
			teamId: data.teamId,
			title: data.title,
			description: data.description,
			assigneeId: data.assigneeId,
		});
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
		return todoService.updateTodo(context.user.id, {
			todoId: data.todoId,
			title: data.title,
			description: data.description,
			done: data.done,
			assigneeId: data.assigneeId,
		});
	});

export const deleteTodo = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ orgId: z.string(), todoId: z.number() }))
	.handler(async ({ data, context }) => {
		return todoService.deleteTodo(context.user.id, data.todoId);
	});
