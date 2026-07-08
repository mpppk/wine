import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { z } from "zod";
import { QuizFeedbackPanel } from "#/components/quiz/QuizFeedbackPanel";
import { useQuizSession } from "#/components/quiz/useQuizSession";
import { Button } from "#/components/ui/button";
import { candidateCountsByType } from "#/lib/quiz/generators";
import {
	QUIZ_TYPE_IDS,
	QUIZ_TYPE_LABELS_JA,
	type QuizQuestion,
	type QuizType,
} from "#/lib/quiz/types";
import { cn } from "#/lib/utils";
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
		const session = await getSession();
		if (!session) {
			throw redirect({ to: "/login" });
		}
		if (!search.region || !getRegion(search.region)?.enabled) {
			throw redirect({ to: "/quiz" });
		}
	},
	component: QuizPlayPage,
});

function QuizPlayPage() {
	const { region, types } = Route.useSearch();
	// beforeLoad で region 未指定は /quiz へリダイレクト済み
	if (!region) return null;
	return <QuizSession regionId={region} types={types} />;
}

function QuizSession({
	regionId,
	types,
}: {
	regionId: RegionId;
	types: string | undefined;
}) {
	const quizTypes = parseQuizTypes(types, regionId);
	const { phase, current, selectedOptionId, tally, answer, next } =
		useQuizSession(regionId, quizTypes);
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
					{regionName} ・{" "}
					{tally.answered > 0
						? `${tally.answered}問中${tally.correct}問正解`
						: "セッション開始"}
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

			{current && (phase === "answering" || phase === "feedback") && (
				<QuestionView
					question={current}
					phase={phase}
					selectedOptionId={selectedOptionId}
					onAnswer={answer}
				/>
			)}

			{/* 画面下のsticky「次へ」(フィードバック表示中のみ) */}
			{phase === "feedback" && (
				<div className="fixed inset-x-0 bottom-0 border-t bg-background/80 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur">
					<Button
						onClick={next}
						size="lg"
						className="mx-auto flex h-14 w-full max-w-lg text-base"
					>
						次へ
					</Button>
				</div>
			)}
		</main>
	);
}

function QuestionView({
	question,
	phase,
	selectedOptionId,
	onAnswer,
}: {
	question: QuizQuestion;
	phase: "answering" | "feedback";
	selectedOptionId: string | undefined;
	onAnswer: (optionId: string) => void;
}) {
	const isFeedback = phase === "feedback";
	return (
		<div className="mt-4 flex flex-col gap-4">
			<div>
				<span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
					{QUIZ_TYPE_LABELS_JA[question.quizType]}
				</span>
				<h1 className="mt-3 text-lg leading-relaxed font-semibold">
					{question.prompt}
				</h1>
			</div>

			<div className="flex flex-col gap-2">
				{question.options.map((option) => {
					const isCorrect = option.id === question.correctOptionId;
					const isSelected = option.id === selectedOptionId;
					return (
						<Button
							key={option.id}
							variant="outline"
							disabled={isFeedback}
							onClick={() => onAnswer(option.id)}
							className={cn(
								"h-auto min-h-14 w-full justify-start px-4 py-3 text-left whitespace-normal",
								// 回答後: 正解は緑、選んだ誤答は赤で明示する
								isFeedback &&
									isCorrect &&
									"border-green-600 bg-green-500/10 text-green-700 disabled:opacity-100 dark:text-green-400",
								isFeedback &&
									isSelected &&
									!isCorrect &&
									"border-destructive bg-destructive/10 text-destructive disabled:opacity-100",
							)}
						>
							<span className="flex flex-col items-start gap-0.5">
								<span className="font-medium">{option.label}</span>
								{option.labelSub && (
									<span className="text-xs font-normal opacity-70">
										{option.labelSub}
									</span>
								)}
							</span>
						</Button>
					);
				})}
			</div>

			{isFeedback && (
				<QuizFeedbackPanel
					isCorrect={selectedOptionId === question.correctOptionId}
					explanation={question.explanation}
				/>
			)}
		</div>
	);
}
