import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	ArrowLeftIcon,
	ShoppingBagIcon,
	Trash2Icon,
	WineIcon,
} from "lucide-react";
import { useState } from "react";
import { DrunkWineForm } from "#/components/cellar/DrunkWineForm";
import { SightingList } from "#/components/cellar/SightingList";
import { TastingList } from "#/components/cellar/TastingList";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { requireAuthBeforeLoad } from "#/lib/route-guard";
import {
	deleteDrunkWine,
	getDrunkWine,
	listWineSightings,
	listWineTastings,
	markWineDrunk,
	updateDrunkWine,
} from "#/server/drunk-wine";
import { listPlaces } from "#/server/place";

export const Route = createFileRoute("/cellar/$entryId/edit")({
	beforeLoad: requireAuthBeforeLoad,
	loader: async ({ params }) => {
		try {
			// 目撃記録の場所を選び直せるよう、場所マスタも一緒に読む(件数は
			// たかが知れているのでページングしない。place-service 参照)
			const [entry, tastings, sightings, places] = await Promise.all([
				getDrunkWine({ data: { id: params.entryId } }),
				listWineTastings({ data: { drunkWineId: params.entryId } }),
				listWineSightings({ data: { drunkWineId: params.entryId } }),
				listPlaces(),
			]);
			return { entry, tastings, sightings, places };
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
	const { entry, tastings, sightings, places } = Route.useLoaderData();
	const navigate = useNavigate();
	const router = useRouter();
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

	// 所有状態の遷移。飲用記録を伴う「飲んだ」だけ専用の server fn を通し、
	// 購入(wishlist/finished → owned)は status の単純更新で足りる。
	const drink = useMutation({
		mutationFn: () => markWineDrunk({ data: { id: entry.id } }),
		onSuccess: () => router.invalidate(),
	});
	const buy = useMutation({
		mutationFn: () =>
			updateDrunkWine({ data: { id: entry.id, status: "owned" } }),
		onSuccess: () => router.invalidate(),
	});
	const transitionPending = drink.isPending || buy.isPending;

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
				<h1 className="text-2xl font-bold">ワインを編集</h1>
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

			<div className="mb-6 flex flex-wrap gap-2">
				{entry.status === "owned" && (
					<Button
						type="button"
						size="sm"
						disabled={transitionPending}
						onClick={() => drink.mutate()}
					>
						<WineIcon className="size-4" aria-hidden />
						{drink.isPending ? "記録中…" : "飲んだ"}
					</Button>
				)}
				{entry.status !== "owned" && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={transitionPending}
						onClick={() => buy.mutate()}
					>
						<ShoppingBagIcon className="size-4" aria-hidden />
						{buy.isPending
							? "更新中…"
							: entry.status === "finished"
								? "もう一度買った"
								: "買った"}
					</Button>
				)}
			</div>

			<DrunkWineForm
				entry={entry}
				onSaved={() => {
					void navigate({ to: "/cellar" });
				}}
				tastingSlot={
					<>
						<TastingList entryId={entry.id} tastings={tastings} />
						{/*
						  目撃記録は「所有状態 ⊥ 飲用履歴」に足した第3の軸(Issue #358)。
						  飲用記録と並べて置き、どちらも 1:N として同じ形で編集できるようにする。
						*/}
						<SightingList
							entryId={entry.id}
							sightings={sightings}
							places={places}
							version={entry.updatedAt}
						/>
					</>
				}
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
