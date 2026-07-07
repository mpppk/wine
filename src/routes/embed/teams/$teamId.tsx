import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { assertTeamAccess } from "#/lib/services/access";
import * as todoService from "#/lib/services/todo-service";
import { getSession } from "#/server/auth";
import { authMiddleware } from "#/server/middleware";

// Server fn scoped to a single team id (the embed only knows the team id).
// Authorization is enforced by the shared service layer.
const getEmbedTodos = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.inputValidator(z.object({ teamId: z.string() }))
	.handler(async ({ data, context }) => {
		const team = await assertTeamAccess(data.teamId, context.user.id);
		const todos = await todoService.listTodos(context.user.id, data.teamId);
		return { team: { id: team.id, name: team.name }, todos };
	});

// Read-only embed of a team's todos, rendered inside an MCP App iframe on the
// host (Claude etc.). Authenticated by the browser cookie session (not the MCP
// OAuth token), so an unauthenticated viewer is redirected to /login inside the
// iframe.
export const Route = createFileRoute("/embed/teams/$teamId")({
	component: EmbedTodosPage,
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: async ({ params }) => {
		return getEmbedTodos({ data: { teamId: params.teamId } });
	},
});

function EmbedTodosPage() {
	const { team, todos } = Route.useLoaderData();

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-shrink-0 items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur-lg">
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{team.name}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<ul className="mx-auto max-w-2xl space-y-2">
					{todos.map((todo) => (
						<li
							key={todo.id}
							className="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
						>
							<Checkbox
								checked={todo.done ?? false}
								disabled
								className="mt-0.5 shrink-0"
							/>
							<div className="min-w-0 flex-1">
								<Label
									className={`font-medium ${todo.done ? "text-muted-foreground line-through" : ""}`}
								>
									{todo.title}
								</Label>
								{todo.description && (
									<p className="mt-0.5 text-sm text-muted-foreground">
										{todo.description}
									</p>
								)}
							</div>
						</li>
					))}
					{todos.length === 0 && (
						<li className="text-sm text-muted-foreground">No todos yet.</li>
					)}
				</ul>
			</div>
		</div>
	);
}
