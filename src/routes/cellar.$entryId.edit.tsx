import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { DrunkWineForm } from "#/components/cellar/DrunkWineForm";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { getSession } from "#/server/auth";
import { deleteDrunkWine, getDrunkWine } from "#/server/drunk-wine";

export const Route = createFileRoute("/cellar/$entryId/edit")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: async ({ params }) => {
		try {
			return await getDrunkWine({ data: { id: params.entryId } });
		} catch (e) {
			// 存在しない/他ユーザのエントリは一覧へ逃がす。
			// それ以外(一時障害等)は握りつぶさずエラー表示に任せる
			if (e instanceof Error && e.message.includes("Entry not found")) {
				throw redirect({ to: "/cellar" });
			}
			throw e;
		}
	},
	component: CellarEditPage,
});

function CellarEditPage() {
	const entry = Route.useLoaderData();
	const navigate = useNavigate();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleteError, setDeleteError] = useState("");

	const { mutate: remove, isPending: deleting } = useMutation({
		mutationFn: () => deleteDrunkWine({ data: { id: entry.id } }),
		onSuccess: () => {
			setConfirmOpen(false);
			void navigate({ to: "/cellar" });
		},
		onError: (err: Error) => setDeleteError(err.message),
	});

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<div className="mb-6 flex items-center gap-2">
				<Button
					asChild
					variant="ghost"
					size="icon"
					aria-label="マイセラーへ戻る"
				>
					<Link to="/cellar">
						<ArrowLeftIcon className="size-4" />
					</Link>
				</Button>
				<h1 className="text-2xl font-bold">記録を編集</h1>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="ml-auto text-destructive"
					onClick={() => setConfirmOpen(true)}
				>
					<Trash2Icon className="size-4" aria-hidden />
					削除
				</Button>
			</div>

			<DrunkWineForm
				entry={entry}
				onSaved={() => {
					void navigate({ to: "/cellar" });
				}}
			/>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>記録を削除しますか?</DialogTitle>
						<DialogDescription>
							「{entry.name}
							」の記録と写真を削除します。この操作は取り消せません。
						</DialogDescription>
					</DialogHeader>
					{deleteError && (
						<p className="text-sm text-destructive">{deleteError}</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={deleting}
							onClick={() => setConfirmOpen(false)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={deleting}
							onClick={() => {
								setDeleteError("");
								remove();
							}}
						>
							{deleting ? "削除中..." : "削除する"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}
