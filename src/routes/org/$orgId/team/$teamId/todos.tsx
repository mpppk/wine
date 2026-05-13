import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "#/lib/auth-client";
import { listMembers } from "#/server/orgs";
import { createTodo, deleteTodo, listTodos, updateTodo } from "#/server/todos";

export const Route = createFileRoute("/org/$orgId/team/$teamId/todos")({
	beforeLoad: async () => {
		const session = await authClient.getSession();
		if (!session.data) {
			throw redirect({ to: "/" });
		}
	},
	loader: async ({ context, params }) => {
		await Promise.all([
			context.queryClient.prefetchQuery({
				queryKey: ["todos", params.teamId],
				queryFn: () =>
					listTodos({ data: { teamId: params.teamId, orgId: params.orgId } }),
			}),
			context.queryClient.prefetchQuery({
				queryKey: ["org-members", params.orgId],
				queryFn: () => listMembers({ data: { orgId: params.orgId } }),
			}),
		]);
	},
	component: TodosPage,
});

function TodosPage() {
	const { orgId, teamId } = Route.useParams();

	const { data: todos, refetch } = useQuery({
		queryKey: ["todos", teamId],
		queryFn: () => listTodos({ data: { teamId, orgId } }),
	});

	const { data: org } = useQuery({
		queryKey: ["org-members", orgId],
		queryFn: () => listMembers({ data: { orgId } }),
	});

	const { data: session } = authClient.useSession();
	const currentMember = org?.members?.find(
		(m) => m.userId === session?.user.id,
	);
	const canEdit =
		currentMember?.role === "admin" || currentMember?.role === "owner";

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [assigneeId, setAssigneeId] = useState("");

	const { mutate: handleCreate, isPending: creating } = useMutation({
		mutationFn: () =>
			createTodo({
				data: {
					orgId,
					teamId,
					title,
					description: description || undefined,
					assigneeId: assigneeId || undefined,
				},
			}),
		onSuccess: () => {
			refetch();
			setTitle("");
			setDescription("");
			setAssigneeId("");
		},
	});

	const { mutate: handleToggle } = useMutation({
		mutationFn: ({ todoId, done }: { todoId: number; done: boolean }) =>
			updateTodo({ data: { orgId, todoId, done } }),
		onSuccess: () => refetch(),
	});

	const { mutate: handleDelete } = useMutation({
		mutationFn: (todoId: number) => deleteTodo({ data: { orgId, todoId } }),
		onSuccess: () => refetch(),
	});

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
				<Link to="/orgs">Organizations</Link>
				<span>/</span>
				<Link to="/org/$orgId" params={{ orgId }}>
					{org?.name ?? orgId}
				</Link>
				<span>/</span>
				<span className="font-medium text-foreground">Todos</span>
			</div>

			<h1 className="mb-6 text-2xl font-bold">Todos</h1>

			<ul className="mb-8 space-y-2">
				{todos?.map((todo) => {
					const assignee = org?.members?.find(
						(m) => m.userId === todo.assigneeId,
					);
					return (
						<li
							key={todo.id}
							className="flex items-start gap-3 rounded-lg border px-4 py-3"
						>
							{canEdit ? (
								<input
									type="checkbox"
									checked={todo.done ?? false}
									onChange={(e) =>
										handleToggle({ todoId: todo.id, done: e.target.checked })
									}
									className="mt-1 h-4 w-4 shrink-0 cursor-pointer"
								/>
							) : (
								<input
									type="checkbox"
									checked={todo.done ?? false}
									readOnly
									className="mt-1 h-4 w-4 shrink-0"
								/>
							)}
							<div className="flex-1 min-w-0">
								<p
									className={`font-medium ${todo.done ? "line-through text-muted-foreground" : ""}`}
								>
									{todo.title}
								</p>
								{todo.description && (
									<p className="text-sm text-muted-foreground mt-0.5">
										{todo.description}
									</p>
								)}
								{assignee && (
									<p className="text-xs text-muted-foreground mt-1">
										Assignee: {assignee.user.name}
									</p>
								)}
							</div>
							{canEdit && (
								<button
									type="button"
									onClick={() => handleDelete(todo.id)}
									className="shrink-0 text-xs text-red-500 hover:text-red-700"
								>
									Delete
								</button>
							)}
						</li>
					);
				})}
				{todos?.length === 0 && (
					<li className="text-muted-foreground text-sm">No todos yet.</li>
				)}
			</ul>

			{canEdit && (
				<div className="rounded-lg border p-4">
					<h2 className="mb-3 font-semibold">Add Todo</h2>
					<div className="flex flex-col gap-2">
						<input
							type="text"
							placeholder="Title *"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && title.trim()) handleCreate();
							}}
							className="rounded border px-3 py-2 text-sm"
						/>
						<input
							type="text"
							placeholder="Description (optional)"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							className="rounded border px-3 py-2 text-sm"
						/>
						<select
							value={assigneeId}
							onChange={(e) => setAssigneeId(e.target.value)}
							className="rounded border px-3 py-2 text-sm"
						>
							<option value="">No assignee</option>
							{org?.members?.map((m) => (
								<option key={m.userId} value={m.userId}>
									{m.user.name}
								</option>
							))}
						</select>
						<button
							type="button"
							disabled={!title.trim() || creating}
							onClick={() => handleCreate()}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
						>
							Add
						</button>
					</div>
				</div>
			)}
		</main>
	);
}
