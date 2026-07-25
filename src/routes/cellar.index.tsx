import { useMutation } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { MapIcon, PlusIcon, WineIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { CellarFilterChips } from "#/components/cellar/CellarFilterChips";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	CELLAR_FILTER_IDS,
	countCellarFilters,
	DEFAULT_CELLAR_FILTER,
	matchesCellarFilter,
} from "#/lib/drunk-wine/filter";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { getSession } from "#/server/auth";
import { listDrunkWines, markWineDrunk } from "#/server/drunk-wine";

export const Route = createFileRoute("/cellar/")({
	// 絞り込みは URL に載せる。地図(/cellar/map)との相互リンクで引き継ぐことが
	// 「両ページで連動」の実装手段になる。
	// catch: 不正値(?filter=xxx)は既定へ黙って倒す。
	// default: 未指定も許す(これが無いと /cellar への全リンクで search が必須になる)。
	validateSearch: z.object({
		filter: z
			.enum(CELLAR_FILTER_IDS)
			.catch(DEFAULT_CELLAR_FILTER)
			.default(DEFAULT_CELLAR_FILTER),
	}),
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
	const router = useRouter();
	const drink = useMutation({
		mutationFn: () => markWineDrunk({ data: { id: entry.id } }),
		onSuccess: () => router.invalidate(),
	});

	return (
		// カード全体がリンクなので、「飲んだ」ボタンをリンクの中には入れられない
		// (<a> 内の interactive nesting になり、クリックもリンクへ吸われる)。
		// 兄弟として絶対配置する。
		<div className="relative h-full">
			<Link
				to="/cellar/$entryId/edit"
				params={{ entryId: entry.id }}
				className="group block h-full"
			>
				<Card className="h-full gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/30">
					{entry.photoUrls[0] ? (
						<img
							// 写真差し替え時にR2キーが同じでも再取得させるキャッシュバスタ。
							// 一覧サムネイルは代表(先頭)の1枚
							src={`${entry.photoUrls[0]}?v=${entry.updatedAt}`}
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
							{entry.lastDrankOn && <span>{entry.lastDrankOn}</span>}
							{entry.tastingCount > 1 && (
								<span>{entry.tastingCount}回飲んだ</span>
							)}
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

			<span className="pointer-events-none absolute left-2 top-2 rounded-full bg-foreground/80 px-2 py-0.5 text-[10px] font-medium leading-none text-background">
				{WINE_STATUS_LABELS_JA[entry.status]}
			</span>

			{entry.status === "owned" && (
				<Button
					type="button"
					size="sm"
					className="absolute bottom-2 right-2 h-7 px-2 text-xs"
					disabled={drink.isPending}
					onClick={() => drink.mutate()}
				>
					{drink.isPending ? "記録中…" : "飲んだ"}
				</Button>
			)}
		</div>
	);
}

function CellarPage() {
	const entries = Route.useLoaderData();
	const { filter } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });

	const counts = useMemo(() => countCellarFilters(entries), [entries]);
	const visible = useMemo(
		() => entries.filter((e) => matchesCellarFilter(e, filter)),
		[entries, filter],
	);

	return (
		<main className="mx-auto max-w-4xl px-4 py-10">
			<div className="mb-6 flex flex-wrap items-center gap-2">
				<h1 className="text-2xl font-bold">マイセラー</h1>
				<div className="ml-auto flex gap-2">
					<Button asChild variant="outline" size="sm">
						<Link to="/cellar/map" search={{ filter }}>
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

			{entries.length > 0 && (
				<div className="mb-4">
					<CellarFilterChips
						value={filter}
						counts={counts}
						onChange={(next) =>
							navigate({ search: { filter: next }, replace: true })
						}
					/>
				</div>
			)}

			{entries.length === 0 ? (
				<div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border py-16">
					<WineIcon className="size-10 text-muted-foreground/40" aria-hidden />
					<p className="text-sm text-muted-foreground">
						まだ記録がありません。飲んだワインも、買っておいたボトルも記録できます。
					</p>
					<Button asChild>
						<Link to="/cellar/new">
							<PlusIcon className="size-4" aria-hidden />
							ワインを記録する
						</Link>
					</Button>
				</div>
			) : visible.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
					この条件に該当するワインはありません。
				</p>
			) : (
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
					{visible.map((entry) => (
						<EntryCard key={entry.id} entry={entry} />
					))}
				</div>
			)}
		</main>
	);
}
