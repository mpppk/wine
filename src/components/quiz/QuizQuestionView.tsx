import { QuizFeedbackPanel } from "#/components/quiz/QuizFeedbackPanel";
import { Button } from "#/components/ui/button";
import { QUIZ_TYPE_LABELS_JA, type QuizQuestion } from "#/lib/quiz/types";
import { cn } from "#/lib/utils";

// 1問分の表示(形式バッジ・設問・4択・回答後のフィードバック)。
// /quiz/play と地図ページのクイズモーダルで共用する。

export function QuizQuestionView({
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
