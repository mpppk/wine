import { useMutation } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { WineIcon } from "lucide-react";
import { buildCellarCardLines } from "#/components/cellar/cellar-card";
import { RatingStars } from "#/components/cellar/RatingStars";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { WINE_STATUS_LABELS_JA } from "#/lib/drunk-wine/status";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import { markWineDrunk } from "#/server/drunk-wine";

// マイセラー一覧(/cellar)の1枚。ルートから切り出してあるのは、一覧に「何を出す・
// 何を出さないか」(Issue #597: 生産者を出し、ヴィンテージを出さない)を
// コンポーネント単位のテストで固定するため。
export function EntryCard({
	entry,
	selectMode,
	selected,
	onToggleSelect,
}: {
	entry: DrunkWineEntry;
	selectMode: boolean;
	selected: boolean;
	onToggleSelect: (id: string) => void;
}) {
	const router = useRouter();
	const drink = useMutation({
		mutationFn: () => markWineDrunk({ data: { id: entry.id } }),
		onSuccess: () => router.invalidate(),
	});

	return (
		// カード全体は閲覧画面へのリンク。「飲んだ」ボタンをリンクの中には入れられない
		// (<a> 内の interactive nesting になり、クリックもリンクへ吸われる)。
		// 兄弟として絶対配置する。選択モード中はカード全体がチェック切り替えに変わる
		// (Issue #363 案B)ので、Link のクリックを奪って遷移させない。
		<div className="relative h-full">
			<Link
				to="/cellar/$entryId"
				params={{ entryId: entry.id }}
				className="group block h-full"
				onClick={(e) => {
					if (!selectMode) return;
					e.preventDefault();
					onToggleSelect(entry.id);
				}}
			>
				<Card className="h-full gap-0 overflow-hidden py-0 transition-colors group-hover:border-foreground/30">
					{entry.thumbUrls[0] ? (
						<img
							// 写真差し替え時にR2キーが同じでも再取得させるキャッシュバスタ。
							// 一覧サムネイルは代表(先頭)の1枚。原寸ではなく縮小版を読む(#237)。
							// サムネイルの実体が無い写真は配信ルートが原寸へフォールバックする。
							src={`${entry.thumbUrls[0]}?v=${entry.updatedAt}`}
							alt={`${entry.name}の写真`}
							className="aspect-square w-full object-cover"
							// 画面外のカードは読み込まない(グリッドは1ページ24件)
							loading="lazy"
							decoding="async"
							width={400}
							height={400}
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
						{entry.lastRating !== null && (
							<RatingStars rating={entry.lastRating} />
						)}
						<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
							{buildCellarCardLines(entry).map((line) => (
								<span key={line.key}>{line.text}</span>
							))}
						</div>
					</CardContent>
				</Card>
			</Link>

			<span className="pointer-events-none absolute left-2 top-2 rounded-full bg-foreground/80 px-2 py-0.5 text-[10px] font-medium leading-none text-background">
				{WINE_STATUS_LABELS_JA[entry.status]}
			</span>

			{selectMode ? (
				<Checkbox
					checked={selected}
					onCheckedChange={() => onToggleSelect(entry.id)}
					aria-label={`${entry.name}を選択`}
					className="absolute right-2 top-2 size-5 border-foreground/40 bg-background"
				/>
			) : (
				entry.status === "owned" && (
					<Button
						type="button"
						size="sm"
						className="absolute bottom-2 right-2 h-7 px-2 text-xs"
						disabled={drink.isPending}
						onClick={() => drink.mutate()}
					>
						{drink.isPending ? "記録中…" : "飲んだ"}
					</Button>
				)
			)}
		</div>
	);
}
