import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/server/auth";
import { listMembers } from "#/server/orgs";
import { createTodo, deleteTodo, listTodos, updateTodo } from "#/server/todos";

export const Route = createFileRoute("/org/$orgId/team/$teamId/todos")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
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
					assigneeId:
						assigneeId && assigneeId !== "unassigned" ? assigneeId : undefined,
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
				<Link to="/orgs" className="hover:text-foreground transition-colors">
					Organizations
				</Link>
				<span>/</span>
				<Link
					to="/org/$orgId"
					params={{ orgId }}
					className="hover:text-foreground transition-colors"
				>
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
							className="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
						>
							<Checkbox
								id={`todo-${todo.id}`}
								checked={todo.done ?? false}
								onCheckedChange={(checked) =>
									canEdit && handleToggle({ todoId: todo.id, done: !!checked })
								}
								disabled={!canEdit}
								className="mt-0.5 shrink-0"
							/>
							<div className="flex-1 min-w-0">
								<Label
									htmlFor={`todo-${todo.id}`}
									className={`font-medium cursor-pointer ${todo.done ? "line-through text-muted-foreground" : ""}`}
								>
									{todo.title}
								</Label>
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
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => handleDelete(todo.id)}
									className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
								>
									Delete
								</Button>
							)}
						</li>
					);
				})}
				{todos?.length === 0 && (
					<li className="text-muted-foreground text-sm">No todos yet.</li>
				)}
			</ul>

			{canEdit && (
				<Card>
					<CardHeader>
						<CardTitle>Add Todo</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-title">Title *</Label>
								<Input
									id="todo-title"
									type="text"
									placeholder="What needs to be done?"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && title.trim()) handleCreate();
									}}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-description">Description</Label>
								<Input
									id="todo-description"
									type="text"
									placeholder="Optional details"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-assignee">Assignee</Label>
								<Select value={assigneeId} onValueChange={setAssigneeId}>
									<SelectTrigger id="todo-assignee">
										<SelectValue placeholder="No assignee" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="unassigned">No assignee</SelectItem>
										{org?.members?.map((m) => (
											<SelectItem key={m.userId} value={m.userId}>
												{m.user.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Button
								type="button"
								disabled={!title.trim() || creating}
								onClick={() => handleCreate()}
							>
								Add
							</Button>
						</div>
					</CardContent>
				</Card>
			)}
		</main>
	);
}
