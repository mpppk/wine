import { z } from "zod";

// Input schemas for MCP tools. Kept free of DB / runtime imports so they can be
// unit tested under vitest (jsdom). Exported as plain zod "raw shape" objects,
// which is what McpServer.registerTool's inputSchema expects.

export const listTeamsInput = {
	org_id: z
		.string()
		.optional()
		.describe(
			"Only return teams of this organization (from list_organizations). " +
				"Omit to list every team the user can access.",
		),
};

export const listTodosInput = {
	team_id: z.string().describe("The team ID (from list_teams)"),
};

// ── Write tools ───────────────────────────────────────────────────────────────

export const createTodoInput = {
	team_id: z
		.string()
		.describe("The team the todo belongs to (from list_teams)"),
	title: z.string().min(1).describe("Todo title"),
	description: z.string().optional().describe("Optional details"),
	assignee_id: z
		.string()
		.optional()
		.describe("User ID to assign (an org member's id; see list_organizations)"),
};

export const updateTodoInput = {
	todo_id: z.number().describe("The todo ID (from list_todos)"),
	title: z.string().min(1).optional(),
	description: z.string().optional(),
	done: z.boolean().optional().describe("Mark the todo done/undone"),
	assignee_id: z
		.string()
		.nullable()
		.optional()
		.describe("User ID to assign, or null to clear the assignee"),
};

export const deleteTodoInput = {
	todo_id: z.number().describe("The todo ID to delete (from list_todos)"),
};
