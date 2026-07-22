import { createFileRoute, Link } from "@tanstack/react-router";
import { LogInIcon, MapIcon, PlayIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { QUIZ_TYPE_LABELS_JA } from "#/lib/quiz/types";
import type { RegionProgress } from "#/lib/services/quiz-service";
import { getRegion } from "#/lib/wine/service";
import { getSession } from "#/server/auth";
import { getQuizProgress } from "#/server/quiz";

export const Route = createFileRoute("/quiz/progress")({
	// 未ログインでも開けるが、進捗はユーザ固有データなのでログイン時のみ取得する
	beforeLoad: async () => {
		const session = await getSession();
		return { isAuthenticated: !!session };
	},
	loader: ({ context }) => (context.isAuthenticated ? getQuizProgress() : null),
	component: QuizProgressPage,
});

function QuizProgressPage() {
	const data = Route.useLoaderData();
	if (!data) return <LoginPrompt />;
	const { regions } = data;

	return (
		<main className="mx-auto max-w-2xl px-4 py-8">
			<h1 className="text-2xl font-semibold">学習の進捗</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				地域×クイズ形式ごとの学習状況です。「苦手」は直近で不正解だった問題、
				「習得」は2回以上連続で正解した問題です。
			</p>

			<div className="mt-6 flex flex-col gap-4">
				{regions.map((region) => (
					<RegionProgressCard key={region.regionId} progress={region} />
				))}
			</div>

			<div className="mt-6">
				<Button asChild variant="outline">
					<Link to="/quiz">クイズ設定に戻る</Link>
				</Button>
			</div>
		</main>
	);
}

function LoginPrompt() {
	return (
		<main className="mx-auto max-w-2xl px-4 py-8">
			<h1 className="text-2xl font-semibold">学習の進捗</h1>
			<Card className="mt-6">
				<CardHeader>
					<CardTitle>ログインすると進捗を確認できます</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						ログインすると回答結果が記録され、ここで地域×クイズ形式ごとの
						学習の進捗を確認できます。ログインなしでもクイズには回答できますが、
						回答結果は記録されません。
					</p>
					<div className="flex flex-wrap gap-2">
						<Button asChild>
							<Link to="/login">
								<LogInIcon className="size-4" aria-hidden />
								ログインする
							</Link>
						</Button>
						<Button asChild variant="outline">
							<Link to="/quiz">クイズ設定に戻る</Link>
						</Button>
					</div>
				</CardContent>
			</Card>
		</main>
	);
}

function RegionProgressCard({ progress }: { progress: RegionProgress }) {
	const region = getRegion(progress.regionId);
	const available = progress.quizTypes.filter((t) => t.candidateCount > 0);
	const totals = available.reduce(
		(acc, t) => ({
			candidate: acc.candidate + t.candidateCount,
			seen: acc.seen + t.seenCount,
			answer: acc.answer + t.answerCount,
			correct: acc.correct + t.correctCount,
		}),
		{ candidate: 0, seen: 0, answer: 0, correct: 0 },
	);
	const accuracy =
		totals.answer > 0 ? Math.round((totals.correct / totals.answer) * 100) : 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-baseline justify-between">
					<span>
						{region?.nameJa}
						<span className="ml-2 text-sm font-normal text-muted-foreground">
							{region?.nameLocal}
						</span>
					</span>
					<span className="text-sm font-normal text-muted-foreground">
						{totals.answer > 0
							? `正答率 ${accuracy}% ・ 未出題 ${Math.max(0, totals.candidate - totals.seen)}問`
							: `全${totals.candidate}問 ・ 未学習`}
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{available.map((t) => {
					const seenPct = Math.min(
						100,
						Math.round((t.seenCount / t.candidateCount) * 100),
					);
					const typeAccuracy =
						t.answerCount > 0
							? Math.round((t.correctCount / t.answerCount) * 100)
							: undefined;
					return (
						<div key={t.quizType}>
							<div className="flex items-baseline justify-between text-sm">
								<span className="font-medium">
									{QUIZ_TYPE_LABELS_JA[t.quizType]}
								</span>
								<span className="text-xs text-muted-foreground">
									{t.seenCount}/{t.candidateCount}問 学習済み
									{typeAccuracy !== undefined && ` ・ 正答率 ${typeAccuracy}%`}
									{t.weakCount > 0 && ` ・ 苦手 ${t.weakCount}`}
									{t.masteredCount > 0 && ` ・ 習得 ${t.masteredCount}`}
								</span>
							</div>
							<div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-primary transition-[width]"
									style={{ width: `${seenPct}%` }}
								/>
							</div>
						</div>
					);
				})}
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="secondary" size="sm">
						<Link
							to="/quiz/play"
							search={{ region: progress.regionId, types: undefined }}
						>
							<PlayIcon className="size-4" aria-hidden />
							この地域でクイズを始める
						</Link>
					</Button>
					<Button asChild variant="outline" size="sm">
						<Link
							to="/map/$regionId"
							params={{ regionId: progress.regionId }}
							search={{ color: "progress" }}
						>
							<MapIcon className="size-4" aria-hidden />
							地図で見る
						</Link>
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
