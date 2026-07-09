import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { cn } from "#/lib/utils";

interface QuizFeedbackPanelProps {
	isCorrect: boolean;
	explanation: string;
}

/** 解答直後に表示する正誤+解説パネル */
export function QuizFeedbackPanel({
	isCorrect,
	explanation,
}: QuizFeedbackPanelProps) {
	return (
		<div
			className={cn(
				"rounded-xl border p-4",
				isCorrect
					? "border-green-600/40 bg-green-500/10"
					: "border-destructive/40 bg-destructive/10",
			)}
		>
			<p
				className={cn(
					"flex items-center gap-1.5 font-semibold",
					isCorrect ? "text-green-700 dark:text-green-400" : "text-destructive",
				)}
			>
				{isCorrect ? (
					<>
						<CheckCircle2Icon className="size-5" aria-hidden />
						正解！
					</>
				) : (
					<>
						<XCircleIcon className="size-5" aria-hidden />
						不正解…
					</>
				)}
			</p>
			<p className="mt-2 whitespace-pre-line text-sm leading-relaxed">
				{explanation}
			</p>
		</div>
	);
}
