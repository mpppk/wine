import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { MapIcon, PlusIcon, WineIcon } from "lucide-react";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { getSession } from "#/server/auth";
import { listDrunkWines } from "#/server/drunk-wine";

export const Route = createFileRoute("/cellar/")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
	},
	loader: () => listDrunkWines(),
	component: CellarPage,
});

function EntryCard({ entry }: { entry: DrunkWineEntry }) {
	return (
		<Link
			to="/cellar/$entryId/edit"
			params={{ entryId: entry.id }}
			className="group block h-full"
		>
			<Card className="h-full gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/30">
				{entry.photoUrl ? (
					<img
						// 写真差し替え時にR2キーが同じでも再取得させるキャッシュバスタ
						src={`${entry.photoUrl}?v=${entry.updatedAt}`}
						alt={`${entry.name}の写真`}
						className="aspect-square w-full object-cover"
					/>
				) : (
					<div className="flex aspect-square w-full items-center justify-center bg-muted">
						<WineIcon
							className="size-10 text-muted-foreground/40"
							aria-hidden
						/>
					</div>
				)}
				<CardContent className="flex flex-col gap-1 p-3">
					<p className="line-clamp-2 text-sm font-medium">{entry.name}</p>
					{entry.rating !== null && <RatingStars rating={entry.rating} />}
					<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
						{entry.drankOn && <span>{entry.drankOn}</span>}
						{entry.aopNameJa && <span>{entry.aopNameJa}</span>}
						<span>
							{[
								entry.vintage !== null ? `${entry.vintage}年` : undefined,
								entry.price !== null
									? `¥${entry.price.toLocaleString()}`
									: undefined,
							]
								.filter(Boolean)
								.join(" ・ ")}
						</span>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}

function CellarPage() {
	const entries = Route.useLoaderData();

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6 flex flex-wrap items-center gap-2">
				<h1 className="text-2xl font-bold">マイセラー</h1>
				<div className="ml-auto flex gap-2">
					<Button asChild variant="outline" size="sm">
						<Link to="/cellar/map">
							<MapIcon className="size-4" aria-hidden />
							地図で見る
						</Link>
					</Button>
					<Button asChild size="sm">
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							追加
						</Link>
					</Button>
				</div>
			</div>

			{entries.length === 0 ? (
				<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-16">
					<WineIcon className="size-10 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ記録がありません。飲んだワインを記録してみましょう。
					</p>
					<Button asChild>
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							ワインを記録する
						</Link>
					</Button>
				</div>
			) : (
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
					{entries.map((entry) => (
						<EntryCard key={entry.id} entry={entry} />
					))}
				</div>
			)}
		</main>
	);
}
