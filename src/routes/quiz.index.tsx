import { createFileRoute, Link } from "@tanstack/react-router";
import { BarChart3Icon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { candidateCountsByType } from "#/lib/quiz/generators";
import { QUIZ_TYPES, type QuizType } from "#/lib/quiz/types";
import { cn } from "#/lib/utils";
import { listRegions } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { getSession } from "#/server/auth";

export const Route = createFileRoute("/quiz/")({
	// 未ログインでも利用可能。ログイン状態はバナー表示の出し分けに使う
	beforeLoad: async () => {
		const session = await getSession();
		return { isAuthenticated: !!session };
	},
	// 静的データなのでサーバ関数は不要。loaderで直接返すとSSRにも乗る。
	loader: () => {
		const regions = listRegions().filter((r) => r.enabled);
		return {
			regions,
			countsByRegion: Object.fromEntries(
				regions.map((r) => [r.id, candidateCountsByType(r.id as RegionId)]),
			),
		};
	},
	component: QuizSetupPage,
});

function QuizSetupPage() {
	const { regions, countsByRegion } = Route.useLoaderData();
	const { isAuthenticated } = Route.useRouteContext();
	const [regionId, setRegionId] = useState<RegionId>(regions[0].id as RegionId);
	const counts = countsByRegion[regionId];
	// 地域を切り替えたら、その地域で成立する形式を全選択に戻す
	const [selectedTypes, setSelectedTypes] = useState<QuizType[]>(() =>
		QUIZ_TYPES.filter((t) => counts[t.id] > 0).map((t) => t.id),
	);

	const selectRegion = (id: RegionId) => {
		setRegionId(id);
		setSelectedTypes(
			QUIZ_TYPES.filter((t) => countsByRegion[id][t.id] > 0).map((t) => t.id),
		);
	};

	const toggleType = (type: QuizType) => {
		setSelectedTypes((prev) =>
			prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
		);
	};

	const totalCount = selectedTypes.reduce((sum, t) => sum + counts[t], 0);

	return (
		<main className="mx-auto max-w-2xl px-4 py-8">
			<h1 className="text-2xl font-semibold">AOPクイズ</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				4択クイズでAOPを暗記しましょう。未出題・不正解・忘れかけの問題が
				優先して出題されます。
			</p>

			{!isAuthenticated && (
				<div className="mt-4 rounded-xl border bg-muted/50 p-4 text-sm text-muted-foreground">
					ログインなしでもクイズに回答できますが、回答結果は記録されません。
					<Link to="/login" className="text-primary hover:underline">
						ログイン
					</Link>
					すると回答結果が記録され、あなたに合わせた出題（未出題・苦手優先）と
					進捗の確認ができます。
				</div>
			)}

			<h2 className="mt-6 text-sm font-medium text-muted-foreground">地域</h2>
			<div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
				{regions.map((region) => (
					<button
						key={region.id}
						type="button"
						onClick={() => selectRegion(region.id as RegionId)}
						className={cn(
							"rounded-xl border p-4 text-left transition-colors",
							region.id === regionId
								? "border-primary bg-primary/5"
								: "hover:border-foreground/40",
						)}
					>
						<span className="font-medium">{region.nameJa}</span>
						<span className="mt-0.5 block text-xs text-muted-foreground">
							{region.nameLocal} ・ {region.aopCount} AOP
						</span>
					</button>
				))}
			</div>

			<h2 className="mt-6 text-sm font-medium text-muted-foreground">
				クイズ形式
			</h2>
			<Card className="mt-2 py-2">
				<CardContent className="px-2">
					{QUIZ_TYPES.map((type) => {
						const count = counts[type.id];
						const disabled = count === 0;
						return (
							<label
								key={type.id}
								htmlFor={`quiz-type-${type.id}`}
								className={cn(
									"flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
									disabled
										? "cursor-not-allowed opacity-50"
										: "hover:bg-muted/50",
								)}
							>
								<Checkbox
									id={`quiz-type-${type.id}`}
									checked={selectedTypes.includes(type.id)}
									disabled={disabled}
									onCheckedChange={() => toggleType(type.id)}
								/>
								<span className="flex-1 text-sm font-medium">
									{type.labelJa}
								</span>
								<span className="text-xs text-muted-foreground">
									{disabled ? "この地域では0問" : `${count}問`}
								</span>
							</label>
						);
					})}
				</CardContent>
			</Card>

			<div className="mt-6 flex flex-col gap-3">
				<Button
					asChild={selectedTypes.length > 0}
					disabled={selectedTypes.length === 0}
					size="lg"
					className="h-14 w-full text-base"
				>
					{selectedTypes.length > 0 ? (
						<Link
							to="/quiz/play"
							search={{ region: regionId, types: selectedTypes.join(",") }}
						>
							<PlayIcon className="size-5" aria-hidden />
							スタート（{totalCount}問から出題）
						</Link>
					) : (
						<span>クイズ形式を選んでください</span>
					)}
				</Button>
				<Button asChild variant="outline">
					<Link to="/quiz/progress">
						<BarChart3Icon className="size-4" aria-hidden />
						学習の進捗を見る
					</Link>
				</Button>
			</div>
		</main>
	);
}
