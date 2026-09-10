import { QuizFeedbackPanel } from "#/components/quiz/QuizFeedbackPanel";
import { Button } from "#/components/ui/button";
import { LiveRegion } from "#/components/ui/live-region";
import {
	isSelectionCorrect,
	QUIZ_TYPE_LABELS_JA,
	type QuizQuestion,
} from "#/lib/quiz/types";
import { cn } from "#/lib/utils";

// 1問分の表示(形式バッジ・設問・選択肢・回答後のフィードバック)。
// /quiz/play と地図ページのクイズモーダルで共用する。
// selectionKind が "multi" の問題はチェックボックス式の複数選択になり、
// 「回答する」で確定する(正誤は正解集合との完全一致)。
export function QuizQuestionView({
	question,
	phase,
	selectedOptionId,
	selectedOptionIds = [],
	onAnswer,
	onToggleOption,
}: {
	question: QuizQuestion;
	phase: "answering" | "feedback";
	selectedOptionId: string | undefined;
	selectedOptionIds?: string[];
	onAnswer: (optionId: string) => void;
	onToggleOption?: (optionId: string) => void;
}) {
	const isFeedback = phase === "feedback";
	const isMulti = question.selectionKind === "multi";
	const multiCorrect =
		isMulti && isSelectionCorrect(question, selectedOptionIds);
	return (
		<div className="mt-4 flex flex-col gap-4">
			<div>
				<span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
					{QUIZ_TYPE_LABELS_JA[question.quizType]}
				</span>
				{/*
				  設問は h2。地図ページのクイズモーダルでは地域名の h1 が既にあり、
				  ここを h1 にすると1ページに h1 が2つ並ぶ(#239)。
				*/}
				<h2 className="mt-3 text-lg leading-relaxed font-semibold">
					{question.prompt}
				</h2>
				{isMulti && !isFeedback && (
					<p className="mt-1 text-sm text-muted-foreground">
						あてはまるものをすべて選んで「回答する」を押してください
					</p>
				)}
			</div>

			<div className="flex flex-col gap-2">
				{question.options.map((option) => {
					if (!isMulti) {
						const isCorrect = option.id === question.correctOptionId;
						const isSelected = option.id === selectedOptionId;
						return (
							<Button
								key={option.id}
								variant="outline"
								// disabled にするとブラウザ仕様でフォーカスが body に落ち、キーボード
								// 利用者は毎問ページ先頭から「次へ」まで辿り直しになる(#239)。
								// aria-disabled + クリック無効化なら、押した選択肢にフォーカスが残る。
								aria-disabled={isFeedback}
								onClick={() => {
									if (isFeedback) return;
									onAnswer(option.id);
								}}
								className={cn(
									"h-auto min-h-14 w-full justify-start px-4 py-3 text-left whitespace-normal",
									// 回答後は押せない見た目・挙動にする(disabled 相当。ただし
									// フォーカス可能なままにしてタブ順から外さない)
									isFeedback && "pointer-events-none opacity-50",
									// 回答後: 正解は緑、選んだ誤答は赤で明示する
									isFeedback &&
										isCorrect &&
										"border-green-600 bg-green-500/10 text-green-700 opacity-100 dark:text-green-400",
									isFeedback &&
										isSelected &&
										!isCorrect &&
										"border-destructive bg-destructive/10 text-destructive opacity-100",
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
					}
					const isCorrectOption = question.correctOptionIds.includes(option.id);
					const isChecked = selectedOptionIds.includes(option.id);
					return (
						<Button
							key={option.id}
							variant="outline"
							aria-pressed={isChecked}
							aria-disabled={isFeedback}
							onClick={() => {
								if (isFeedback) return;
								onToggleOption?.(option.id);
							}}
							className={cn(
								"h-auto min-h-14 w-full justify-start px-4 py-3 text-left whitespace-normal",
								// 回答中: チェック済みは枠を強調する
								!isFeedback &&
									isChecked &&
									"border-primary bg-primary/10 opacity-100",
								isFeedback && "pointer-events-none opacity-50",
								// 回答後: 正しく選べたものは緑、誤って選んだものは赤、
								// 選び漏らした正解は緑の枠で示す
								isFeedback &&
									isCorrectOption &&
									isChecked &&
									"border-green-600 bg-green-500/10 text-green-700 opacity-100 dark:text-green-400",
								isFeedback &&
									isCorrectOption &&
									!isChecked &&
									"border-green-600 text-green-700 opacity-100 dark:text-green-400",
								isFeedback &&
									!isCorrectOption &&
									isChecked &&
									"border-destructive bg-destructive/10 text-destructive opacity-100",
							)}
						>
							<span className="flex w-full items-center gap-2.5">
								<span
									aria-hidden
									className={cn(
										"flex size-5 shrink-0 items-center justify-center rounded-md border text-sm leading-none",
										isChecked &&
											!isFeedback &&
											"border-primary bg-primary text-primary-foreground",
										isFeedback &&
											isCorrectOption &&
											isChecked &&
											"border-green-600 bg-green-600 text-white",
										isFeedback &&
											isCorrectOption &&
											!isChecked &&
											"border-green-600 text-green-700",
										isFeedback &&
											!isCorrectOption &&
											isChecked &&
											"border-destructive bg-destructive text-white",
									)}
								>
									{isChecked ? "✓" : ""}
								</span>
								<span className="flex flex-col items-start gap-0.5">
									<span className="font-medium">{option.label}</span>
									{option.labelSub && (
										<span className="text-xs font-normal opacity-70">
											{option.labelSub}
										</span>
									)}
									{isFeedback && isCorrectOption && !isChecked && (
										<span className="text-xs font-normal opacity-80">
											正解(選び漏れ)
										</span>
									)}
								</span>
							</span>
						</Button>
					);
				})}
			</div>

			{/*
			  正誤+解説はライブリージョンの中身として出す。コンテナごと条件描画すると
			  読み上げられないことがあるため、フィードバックが無い間も空のまま置いておく(#239)。
			*/}
			{/* 空のときは親の gap-4 ぶんを打ち消し、余白が増えないようにする
			    (display:none にすると支援技術から消えてライブリージョンとして機能しない) */}
			<LiveRegion className="empty:-mt-4">
				{isFeedback && (
					<QuizFeedbackPanel
						isCorrect={
							isMulti
								? multiCorrect
								: selectedOptionId === question.correctOptionId
						}
						explanation={question.explanation}
					/>
				)}
			</LiveRegion>
		</div>
	);
}
