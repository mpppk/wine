import { Link } from "@tanstack/react-router";
import {
	BarChart3Icon,
	BookOpenIcon,
	FlameIcon,
	MapIcon,
	PlayIcon,
	SparklesIcon,
	TargetIcon,
	WineIcon,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import type { DashboardData } from "#/lib/services/dashboard-service";
import { cn } from "#/lib/utils";
import { getRegion } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";

// ログイン後トップページの学習ダッシュボード。getDashboard の結果を受け取り、
// 「今日どこから学ぶか」「今日どれだけ学んだか」を一望できるよう描画する。

export function DashboardView({
	data,
	userName,
}: {
	data: DashboardData;
	userName: string | null;
}) {
	return (
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
			<header>
				<h1 className="text-2xl font-semibold">
					{userName ? `${userName} さんの学習` : "学習ダッシュボード"}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					今日の学習状況とおすすめの学習を確認できます。
				</p>
			</header>

			<RecommendationHero recommendation={data.recommendation} />
			<TodaySummary
				today={data.today}
				streak={data.streak}
				cellar={data.cellar}
			/>
			<MasteryCard mastery={data.mastery} />
			{data.mastery.weak > 0 && <ReviewCard weak={data.mastery.weak} />}
			<HeatmapCard heatmap={data.heatmap} />
			<QuickAccess />
		</main>
	);
}

// --- 今日のナビ(ヒーロー) --------------------------------------------------

function RecommendationHero({
	recommendation,
}: {
	recommendation: DashboardData["recommendation"];
}) {
	const { reason, count } = recommendation;
	const region =
		recommendation.regionId != null
			? getRegion(recommendation.regionId)
			: undefined;
	const regionName = region?.nameJa ?? "";

	let heading: string;
	let detail: string;
	if (reason === "weak") {
		heading = "苦手を復習しましょう";
		detail = `${regionName} に直近で間違えた問題が ${count} 問あります。`;
	} else if (reason === "unseen") {
		heading = "新しく学びましょう";
		detail = `${regionName} にまだ出題していない問題が ${count} 問あります。`;
	} else if (reason === "mastery") {
		heading = "おさらいしましょう";
		detail = `${regionName} をもう一度復習して定着させましょう。`;
	} else {
		heading = "まずは地図から";
		detail = "地図で地域ごとのAOPを眺めてみましょう。";
	}

	return (
		<Card className="border-primary/40 bg-primary/5">
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2 text-sm font-medium text-primary">
					<SparklesIcon className="size-4" aria-hidden />
					今日はここから
				</div>
				<div>
					<p className="text-lg font-semibold">{heading}</p>
					<p className="mt-1 text-sm text-muted-foreground">{detail}</p>
				</div>
				{recommendation.regionId != null ? (
					<Button asChild size="lg" className="self-start">
						<Link
							to="/quiz/play"
							search={{
								region: recommendation.regionId as RegionId,
								types: undefined,
							}}
						>
							<PlayIcon className="size-5" aria-hidden />
							{regionName}で学習を始める
						</Link>
					</Button>
				) : (
					<Button asChild size="lg" className="self-start">
						<Link to="/regions">
							<MapIcon className="size-5" aria-hidden />
							地図を開く
						</Link>
					</Button>
				)}
			</CardContent>
		</Card>
	);
}

// --- 今日の学習サマリー ----------------------------------------------------

function TodaySummary({
	today,
	streak,
	cellar,
}: {
	today: DashboardData["today"];
	streak: number;
	cellar: DashboardData["cellar"];
}) {
	const accuracy =
		today.answered > 0
			? Math.round((today.correct / today.answered) * 100)
			: null;
	const goalPct = Math.min(
		100,
		Math.round((today.answered / today.goal) * 100),
	);
	const goalReached = today.answered >= today.goal;

	return (
		<Card>
			<CardContent className="flex flex-col gap-4">
				<div className="grid grid-cols-3 gap-3">
					<StatTile
						icon={<BookOpenIcon className="size-4" aria-hidden />}
						label="今日の解答"
						value={`${today.answered}`}
						sub={accuracy !== null ? `正答率 ${accuracy}%` : "問"}
					/>
					<StatTile
						icon={
							<FlameIcon
								className={cn(
									"size-4",
									streak > 0 ? "text-orange-500" : undefined,
								)}
								aria-hidden
							/>
						}
						label="連続学習"
						value={`${streak}`}
						sub="日"
					/>
					<StatTile
						icon={<WineIcon className="size-4" aria-hidden />}
						label="セラー"
						value={`${cellar.count}`}
						sub="本"
					/>
				</div>

				<div>
					<div className="flex items-baseline justify-between text-sm">
						<span className="flex items-center gap-1.5 font-medium">
							<TargetIcon
								className="size-4 text-muted-foreground"
								aria-hidden
							/>
							今日の目標
						</span>
						<span className="text-xs text-muted-foreground">
							{goalReached ? "達成！" : `${today.answered} / ${today.goal} 問`}
						</span>
					</div>
					<div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
						<div
							className={cn(
								"h-full rounded-full transition-[width]",
								goalReached ? "bg-green-500" : "bg-primary",
							)}
							style={{ width: `${goalPct}%` }}
						/>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function StatTile({
	icon,
	label,
	value,
	sub,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	sub: string;
}) {
	return (
		<div className="rounded-xl border p-3">
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				{icon}
				{label}
			</div>
			<div className="mt-1 flex items-baseline gap-1">
				<span className="text-2xl font-semibold tabular-nums">{value}</span>
				<span className="text-xs text-muted-foreground">{sub}</span>
			</div>
		</div>
	);
}

// --- 習熟度スタックバー ----------------------------------------------------

function MasteryCard({ mastery }: { mastery: DashboardData["mastery"] }) {
	const { total, seen, mastered } = mastery;
	const learning = Math.max(0, seen - mastered);
	const unseen = Math.max(0, total - seen);
	const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-baseline justify-between">
					<span className="font-medium">全体の習熟度</span>
					<span className="text-xs text-muted-foreground">
						習得 {mastered} / 全 {total} 問
					</span>
				</div>
				<div className="flex h-3 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full bg-green-500"
						style={{ width: `${pct(mastered)}%` }}
					/>
					<div
						className="h-full bg-primary"
						style={{ width: `${pct(learning)}%` }}
					/>
				</div>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<LegendDot className="bg-green-500" label={`習得 ${mastered}`} />
					<LegendDot className="bg-primary" label={`学習中 ${learning}`} />
					<LegendDot className="bg-muted" label={`未学習 ${unseen}`} />
				</div>
				<Button asChild variant="outline" size="sm" className="self-start">
					<Link to="/quiz/progress">
						<BarChart3Icon className="size-4" aria-hidden />
						詳しい進捗を見る
					</Link>
				</Button>
			</CardContent>
		</Card>
	);
}

function LegendDot({ className, label }: { className: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5">
			<span className={cn("size-2.5 rounded-full", className)} aria-hidden />
			{label}
		</span>
	);
}

// --- 復習キュー ------------------------------------------------------------

function ReviewCard({ weak }: { weak: number }) {
	return (
		<Card>
			<CardContent className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="font-medium">復習が必要な問題</p>
					<p className="mt-0.5 text-sm text-muted-foreground">
						直近で間違えた苦手な問題が {weak} 問あります。
					</p>
				</div>
				<Button asChild variant="secondary">
					<Link to="/quiz">
						<PlayIcon className="size-4" aria-hidden />
						クイズで復習する
					</Link>
				</Button>
			</CardContent>
		</Card>
	);
}

// --- 学習履歴ヒートマップ --------------------------------------------------

function heatLevel(answered: number): number {
	if (answered <= 0) return 0;
	if (answered < 4) return 1;
	if (answered < 8) return 2;
	return 3;
}

const HEAT_CLASSES = [
	"bg-muted",
	"bg-primary/30",
	"bg-primary/60",
	"bg-primary",
] as const;

function HeatmapCard({ heatmap }: { heatmap: DashboardData["heatmap"] }) {
	// GitHub風に週(列)×曜日(行7)で並べる。先頭の曜日ぶんだけ空セルを詰めて
	// 各列を曜日で揃える。日付は "YYYY-MM-DD" 固定なのでUTCで曜日を導出できる。
	const firstDay = heatmap[0]?.day;
	const leadingBlanks = firstDay
		? new Date(`${firstDay}T00:00:00Z`).getUTCDay()
		: 0;
	const activeDays = heatmap.filter((d) => d.answered > 0).length;

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-baseline justify-between">
					<span className="font-medium">学習の記録</span>
					<span className="text-xs text-muted-foreground">
						直近12週で {activeDays} 日学習
					</span>
				</div>
				<div className="overflow-x-auto">
					<div className="grid grid-flow-col grid-rows-7 gap-1">
						{Array.from({ length: leadingBlanks }).map((_, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 固定の空セル埋め
							<div key={`blank-${i}`} className="size-3" />
						))}
						{heatmap.map((cell) => (
							<div
								key={cell.day}
								className={cn(
									"size-3 rounded-[3px]",
									HEAT_CLASSES[heatLevel(cell.answered)],
								)}
								title={`${cell.day}: ${cell.answered}問`}
							/>
						))}
					</div>
				</div>
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<span>少</span>
					{HEAT_CLASSES.map((c) => (
						<span
							key={c}
							className={cn("size-3 rounded-[3px]", c)}
							aria-hidden
						/>
					))}
					<span>多</span>
				</div>
			</CardContent>
		</Card>
	);
}

// --- クイックアクセス ------------------------------------------------------

function QuickAccess() {
	return (
		<div className="flex flex-wrap gap-2">
			<Button asChild variant="outline">
				<Link to="/regions">
					<MapIcon className="size-4" aria-hidden />
					地図でAOPを学ぶ
				</Link>
			</Button>
			<Button asChild variant="outline">
				<Link to="/quiz">
					<PlayIcon className="size-4" aria-hidden />
					クイズ設定
				</Link>
			</Button>
			<Button asChild variant="outline">
				<Link to="/cellar">
					<WineIcon className="size-4" aria-hidden />
					マイセラー
				</Link>
			</Button>
		</div>
	);
}
