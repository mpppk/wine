import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { RotateCcwIcon, SkipForwardIcon, XIcon } from "lucide-react";
import { z } from "zod";
import {
	AdInterstitialDialog,
	useQuizAdInterstitial,
} from "#/components/ads/AdInterstitialDialog";
import { QuizQuestionView } from "#/components/quiz/QuizQuestionView";
import { useQuizSession } from "#/components/quiz/useQuizSession";
import { Button } from "#/components/ui/button";
import { candidateCountsByType } from "#/lib/quiz/generators";
import { QUIZ_TYPE_IDS, type QuizType } from "#/lib/quiz/types";
import { REGION_IDS } from "#/lib/wine/regions";
import { getRegion } from "#/lib/wine/service";
import type { RegionId } from "#/lib/wine/types";
import { getSession } from "#/server/auth";

// URLにはセッション設定(地域・形式)のみを載せる。出題キューやタリーは
// ローカルstate(リロードで新しいセッションが始まる)。
const searchSchema = z.object({
	// 地域は REGIONS から導出(新地域が自動で対象になる)
	region: z.enum(REGION_IDS).optional().catch(undefined),
	/** 出題する形式(カンマ区切り)。省略・全滅時はその地域で成立する全形式 */
	types: z.string().optional().catch(undefined),
});

// 不正値や候補0問の形式は捨て、有効値が無ければ成立する全形式へフォールバック
function parseQuizTypes(
	types: string | undefined,
	regionId: RegionId,
): QuizType[] {
	const counts = candidateCountsByType(regionId);
	const available = QUIZ_TYPE_IDS.filter((t) => counts[t] > 0);
	if (!types) return available;
	const parts = types.split(",");
	const valid = available.filter((t) => parts.includes(t));
	return valid.length > 0 ? valid : available;
}

export const Route = createFileRoute("/quiz/play")({
	validateSearch: searchSchema,
	beforeLoad: async ({ search }) => {
		if (!search.region || !getRegion(search.region)?.enabled) {
			throw redirect({ to: "/quiz" });
		}
		// 未ログインでもプレイ可能。記録の有無だけが変わるので、
		// SSR時点で確定するログイン状態を context で下に渡す
		const session = await getSession();
		return { isAuthenticated: !!session };
	},
	component: QuizPlayPage,
});

function QuizPlayPage() {
	const { region, types } = Route.useSearch();
	const { isAuthenticated } = Route.useRouteContext();
	// beforeLoad で region 未指定は /quiz へリダイレクト済み
	if (!region) return null;
	return (
		<QuizSession
			regionId={region}
			types={types}
			isAuthenticated={isAuthenticated}
		/>
	);
}

function QuizSession({
	regionId,
	types,
	isAuthenticated,
}: {
	regionId: RegionId;
	types: string | undefined;
	isAuthenticated: boolean;
}) {
	const quizTypes = parseQuizTypes(types, regionId);
	const {
		phase,
		current,
		selectedOptionId,
		tally,
		remaining,
		answer,
		reset,
		skip,
		next,
		retry,
	} = useQuizSession(regionId, quizTypes, isAuthenticated);
	// 10問回答ごとに「次へ」へ広告を割り込ませる(無料会員のみ)
	const { adOpen, onAdOpenChange, nextWithAd } = useQuizAdInterstitial(
		tally.answered,
		next,
	);
	const regionName = getRegion(regionId)?.nameJa;

	return (
		<main className="mx-auto flex min-h-[calc(100dvh-57px)] max-w-lg flex-col px-4 pt-4 pb-32 sm:min-h-[calc(100dvh-65px)]">
			<div className="flex items-center justify-between">
				<Button asChild variant="ghost" size="sm">
					<Link to="/quiz/progress">
						<XIcon className="size-4" aria-hidden />
						終了
					</Link>
				</Button>
				<p className="text-sm text-muted-foreground">
					{regionName}
					{remaining !== null && ` ・ 残り${remaining}問`}
					{tally.answered > 0 &&
						` ・ ${tally.answered}問中${tally.correct}問正解`}
				</p>
			</div>

			{phase === "loading" && (
				<div className="flex flex-1 items-center justify-center">
					<p className="text-sm text-muted-foreground">問題を準備中…</p>
				</div>
			)}

			{phase === "empty" && (
				<div className="flex flex-1 flex-col items-center justify-center gap-4">
					<p className="text-sm text-muted-foreground">
						この条件で出題できる問題がありません。
					</p>
					<Button asChild variant="outline">
						<Link to="/quiz">設定に戻る</Link>
					</Button>
				</div>
			)}

			{phase === "error" && (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
					<p className="text-sm text-muted-foreground">
						問題の読み込みに失敗しました。
						<br />
						通信環境を確認して再試行してください。
					</p>
					<div className="flex gap-2">
						<Button onClick={retry}>再試行</Button>
						<Button asChild variant="outline">
							<Link to="/quiz">設定に戻る</Link>
						</Button>
					</div>
				</div>
			)}

			{phase === "done" && (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
					<p className="text-4xl" aria-hidden>
						🎉
					</p>
					<p className="text-lg font-semibold">
						{tally.answered > 0
							? "全問正解しました！"
							: "この条件の問題はすべて正解済みです"}
					</p>
					{tally.answered > 0 && (
						<p className="text-sm text-muted-foreground">
							このセッション: {tally.answered}問中{tally.correct}問正解
						</p>
					)}
					<div className="flex gap-2">
						<Button asChild>
							<Link to="/quiz/progress">学習の進捗を見る</Link>
						</Button>
						<Button asChild variant="outline">
							<Link to="/quiz">設定に戻る</Link>
						</Button>
					</div>
				</div>
			)}

			{current && (phase === "answering" || phase === "feedback") && (
				<QuizQuestionView
					question={current}
					phase={phase}
					selectedOptionId={selectedOptionId}
					onAnswer={answer}
				/>
			)}

			{/* 画面下のstickyバー。回答中はスキップ、フィードバック中は取り消し＋次へ */}
			{phase === "answering" && (
				<div className="fixed inset-x-0 bottom-0 border-t bg-background/80 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur">
					<Button
						onClick={skip}
						variant="ghost"
						size="lg"
						className="mx-auto flex h-14 w-full max-w-lg text-base text-muted-foreground"
					>
						<SkipForwardIcon className="size-4" aria-hidden />
						スキップ
					</Button>
				</div>
			)}
			{phase === "feedback" && (
				<div className="fixed inset-x-0 bottom-0 border-t bg-background/80 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur">
					<div className="mx-auto flex w-full max-w-lg gap-2">
						<Button
							onClick={reset}
							variant="outline"
							size="lg"
							className="h-14 text-base"
						>
							<RotateCcwIcon className="size-4" aria-hidden />
							回答を取り消す
						</Button>
						<Button
							onClick={nextWithAd}
							size="lg"
							className="h-14 flex-1 text-base"
						>
							次へ
						</Button>
					</div>
				</div>
			)}

			<AdInterstitialDialog open={adOpen} onOpenChange={onAdOpenChange} />
		</main>
	);
}
