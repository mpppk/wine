import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { SearchIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { totalPages } from "#/lib/admin/search";
import { authClient } from "#/lib/auth-client";
import type { AdminUserListItem } from "#/lib/services/admin-service";
import { adminListUsers } from "#/server/admin";
import { getSession } from "#/server/auth";

interface AdminSearch {
	q?: string;
	page?: number;
}

export const Route = createFileRoute("/admin/")({
	validateSearch: (search: Record<string, unknown>): AdminSearch => ({
		q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
		page:
			typeof search.page === "number" && search.page > 1
				? Math.floor(search.page)
				: undefined,
	}),
	loaderDeps: ({ search }) => ({ q: search.q, page: search.page ?? 1 }),
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
		// 非管理者には管理画面の存在を示さず、トップへ黙って戻す。
		if (session.user.role !== "admin") {
			throw redirect({ to: "/" });
		}
	},
	loader: ({ deps }) => adminListUsers({ data: deps }),
	component: AdminUsersPage,
});

function PlanBadge({ plan }: { plan: AdminUserListItem["plan"] }) {
	return plan === "premium" ? (
		<span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
			プレミアム
		</span>
	) : (
		<span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
			無料
		</span>
	);
}

function UserRow({ row, selfId }: { row: AdminUserListItem; selfId?: string }) {
	return (
		<tr className="border-b border-border last:border-b-0 hover:bg-muted/50">
			<td className="px-3 py-2">
				<Link
					to="/admin/$userId"
					params={{ userId: row.id }}
					className="flex items-center gap-2 font-medium hover:underline"
				>
					{row.image ? (
						<img
							src={row.image}
							alt=""
							className="size-6 shrink-0 rounded-full object-cover"
						/>
					) : (
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
							{row.name.charAt(0).toUpperCase()}
						</span>
					)}
					<span className="whitespace-nowrap">{row.name}</span>
					{row.id === selfId && (
						<span className="rounded-full border border-border px-1.5 text-xs text-muted-foreground">
							自分
						</span>
					)}
				</Link>
			</td>
			<td className="px-3 py-2 text-muted-foreground">{row.email}</td>
			<td className="px-3 py-2">
				<PlanBadge plan={row.plan} />
			</td>
			<td className="px-3 py-2 text-right tabular-nums">
				{row.creditBalance ?? (
					<span className="text-muted-foreground">未付与</span>
				)}
			</td>
			<td className="px-3 py-2">
				{row.banned ? (
					<span className="inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
						停止中
					</span>
				) : row.role === "admin" ? (
					<span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
						管理者
					</span>
				) : null}
			</td>
			<td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
				{row.createdAt.toLocaleDateString("ja-JP")}
			</td>
		</tr>
	);
}

function AdminUsersPage() {
	const result = Route.useLoaderData();
	const { q } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data: session } = authClient.useSession();
	const [input, setInput] = useState(q ?? "");

	const pages = totalPages(result.total, result.pageSize);

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6 flex flex-wrap items-center gap-2">
				<h1 className="text-2xl font-bold">ユーザー管理</h1>
				<span className="text-sm text-muted-foreground">
					{result.total.toLocaleString("ja-JP")}件
				</span>
			</div>

			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const trimmed = input.trim();
					void navigate({
						search: {
							q: trimmed === "" ? undefined : trimmed,
							page: undefined,
						},
					});
				}}
			>
				<Input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="名前・メールアドレスで検索"
					aria-label="ユーザー検索"
					className="max-w-sm"
				/>
				<Button type="submit" variant="outline">
					<SearchIcon className="size-4" aria-hidden />
					検索
				</Button>
			</form>

			{result.users.length === 0 ? (
				<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-16">
					<UsersIcon className="size-10 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						該当するユーザーがいません
					</p>
				</div>
			) : (
				<Card className="py-0">
					<CardContent className="overflow-x-auto p-0">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border text-left text-xs text-muted-foreground">
									<th className="px-3 py-2 font-medium">名前</th>
									<th className="px-3 py-2 font-medium">メール</th>
									<th className="px-3 py-2 font-medium">プラン</th>
									<th className="px-3 py-2 text-right font-medium">
										クレジット
									</th>
									<th className="px-3 py-2 font-medium">状態</th>
									<th className="px-3 py-2 font-medium">登録日</th>
								</tr>
							</thead>
							<tbody>
								{result.users.map((row) => (
									<UserRow key={row.id} row={row} selfId={session?.user.id} />
								))}
							</tbody>
						</table>
					</CardContent>
				</Card>
			)}

			{pages > 1 && (
				<div className="mt-4 flex items-center justify-center gap-4">
					{result.page > 1 ? (
						<Button asChild variant="outline" size="sm">
							<Link
								to="/admin"
								search={{
									q,
									page: result.page - 1 > 1 ? result.page - 1 : undefined,
								}}
							>
								前へ
							</Link>
						</Button>
					) : (
						<Button variant="outline" size="sm" disabled>
							前へ
						</Button>
					)}
					<span className="text-sm text-muted-foreground">
						{result.page} / {pages}
					</span>
					{result.page < pages ? (
						<Button asChild variant="outline" size="sm">
							<Link to="/admin" search={{ q, page: result.page + 1 }}>
								次へ
							</Link>
						</Button>
					) : (
						<Button variant="outline" size="sm" disabled>
							次へ
						</Button>
					)}
				</div>
			)}
		</main>
	);
}
