import { env } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as orgService from "#/lib/services/org-service";
import * as todoService from "#/lib/services/todo-service";
import * as userService from "#/lib/services/user-service";
import { buildTodosUiResource, TODOS_RESOURCE_URI } from "./apps";
import {
	createTodoInput,
	deleteTodoInput,
	listTeamsInput,
	listTodosInput,
	updateTodoInput,
} from "./schemas";

// Serialize a result as both structured content and a text mirror; MCP clients
// without structured-content support read the text form.
function ok(payload: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	};
}

function err(e: unknown): CallToolResult {
	const message = e instanceof Error ? e.message : String(e);
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true,
	};
}

export function registerReadTools(server: McpServer, userId: string) {
	server.registerTool(
		"get_current_user",
		{
			title: "Get current user",
			description:
				"Get the account info (id, name, email, avatar) of the signed-in " +
				"user this MCP connection is authenticated as.",
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				const user = await userService.getCurrentUser(userId);
				return ok({ user });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"list_organizations",
		{
			title: "List organizations",
			description:
				"List the organizations the signed-in user belongs to, with the " +
				"user's role in each. Todos live under teams inside organizations.",
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				const organizations = await orgService.listOrganizations(userId);
				return ok({ organizations });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"list_teams",
		{
			title: "List teams",
			description:
				"List the teams the user can access. Optionally filter to a single " +
				"organization. Todos are scoped to a team, so pass a team's id to " +
				"list_todos / create_todo.",
			inputSchema: listTeamsInput,
			annotations: { readOnlyHint: true },
		},
		async ({ org_id }) => {
			try {
				const teams = await orgService.listTeams(userId, org_id);
				return ok({ teams });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"list_todos",
		{
			title: "List todos",
			description: "List all todos of a team.",
			inputSchema: listTodosInput,
			annotations: { readOnlyHint: true },
			// MCP Apps (SEP): associate a UI so hosts render the todo list inline.
			_meta: { ui: { resourceUri: TODOS_RESOURCE_URI } },
		},
		async ({ team_id }) => {
			try {
				const todos = await todoService.listTodos(userId, team_id);
				const payload = { team_id, todos };
				// Attach a read-only MCP App (mcp-ui) that renders the todo list in
				// the host via an iframe pointed at the app's own /embed route.
				const ui = buildTodosUiResource(env.BETTER_AUTH_URL, team_id);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }, ui],
					structuredContent: payload as Record<string, unknown>,
				};
			} catch (e) {
				return err(e);
			}
		},
	);
}

export function registerWriteTools(server: McpServer, userId: string) {
	server.registerTool(
		"create_todo",
		{
			title: "Create todo",
			description:
				"Create a todo in a team. Requires org admin/owner. Returns the " +
				"created todo.",
			inputSchema: createTodoInput,
			annotations: { destructiveHint: false },
		},
		async ({ team_id, title, description, assignee_id }) => {
			try {
				const todo = await todoService.createTodo(userId, {
					teamId: team_id,
					title,
					description,
					assigneeId: assignee_id,
				});
				return ok({ todo });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"update_todo",
		{
			title: "Update todo",
			description:
				"Update a todo's title, description, done state and/or assignee. " +
				"Requires org admin/owner. Provide at least one field.",
			inputSchema: updateTodoInput,
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ todo_id, title, description, done, assignee_id }) => {
			try {
				const todo = await todoService.updateTodo(userId, {
					todoId: todo_id,
					title,
					description,
					done,
					assigneeId: assignee_id,
				});
				return ok({ todo });
			} catch (e) {
				return err(e);
			}
		},
	);

	server.registerTool(
		"delete_todo",
		{
			title: "Delete todo",
			description: "Delete a todo by ID. Requires org admin/owner.",
			inputSchema: deleteTodoInput,
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ todo_id }) => {
			try {
				return ok(await todoService.deleteTodo(userId, todo_id));
			} catch (e) {
				return err(e);
			}
		},
	);
}
