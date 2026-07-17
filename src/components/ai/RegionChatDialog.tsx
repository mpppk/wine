import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { InsufficientCreditsDialog } from "#/components/credit/InsufficientCreditsDialog";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Textarea } from "#/components/ui/textarea";
import type { ChatMessage } from "#/lib/ai/region-qa";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalanceValue,
} from "#/lib/credit/use-credit";
import { askRegion } from "#/server/ai";

// 地図ページ内の地域チャットQ&A。会話履歴はここで保持し、毎ターン server fn に渡す
// (サーバはステートレス)。回答ごとにAIクレジットを消費し、成功で残高クエリを無効化する。
export function RegionChatDialog({
	open,
	onOpenChange,
	regionId,
	regionNameJa,
	aopId,
	aopNameJa,
	isAuthenticated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	regionId: string;
	regionNameJa: string;
	/** 選択中AOP(あれば回答の文脈に含める) */
	aopId?: string;
	aopNameJa?: string;
	isAuthenticated: boolean;
}) {
	const queryClient = useQueryClient();
	const balance = useCreditBalanceValue();
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);

	const { mutate, isPending } = useMutation({
		mutationFn: (vars: { question: string; history: ChatMessage[] }) =>
			askRegion({
				data: {
					regionId,
					aopId,
					question: vars.question,
					history: vars.history,
				},
			}),
		onSuccess: (result, vars) => {
			void queryClient.invalidateQueries({
				queryKey: CREDIT_BALANCE_QUERY_KEY,
			});
			setPendingQuestion(null);
			if (result.blocked) {
				setShowInsufficient(true);
				return;
			}
			setError("");
			setMessages((prev) => [
				...prev,
				{ role: "user", content: vars.question },
				{ role: "assistant", content: result.answer },
			]);
		},
		onError: (e: Error) => {
			setPendingQuestion(null);
			setError(e.message || "回答の生成に失敗しました。");
		},
	});

	const trimmed = input.trim();
	const outOfCredits = balance !== null && balance <= 0;
	const canSend =
		isAuthenticated &&
		!!trimmed &&
		!isPending &&
		!pendingQuestion &&
		!outOfCredits;

	const submit = () => {
		if (!canSend) return;
		const question = trimmed;
		setInput("");
		setError("");
		setPendingQuestion(question);
		mutate({ question, history: messages });
	};

	const title = aopNameJa
		? `${aopNameJa} について質問`
		: `${regionNameJa} について質問`;

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-lg"
					aria-describedby={undefined}
				>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<SparklesIcon className="size-4 text-primary" aria-hidden />
							{title}
						</DialogTitle>
						<DialogDescription>
							この地域のデータをもとにAIが回答します。1回の回答でAIクレジットを消費します。
						</DialogDescription>
					</DialogHeader>

					{!isAuthenticated ? (
						<div className="flex flex-col items-center gap-3 py-8 text-center">
							<p className="text-sm text-muted-foreground">
								この機能を使うにはログインが必要です。
							</p>
							<Button asChild>
								<Link to="/login">ログイン</Link>
							</Button>
						</div>
					) : (
						<>
							<div className="flex min-h-32 flex-1 flex-col gap-3 overflow-y-auto">
								{messages.length === 0 && !pendingQuestion && (
									<p className="py-6 text-center text-sm text-muted-foreground">
										例:「主なブドウ品種は?」「どんな土壌?」など、この地域について質問できます。
									</p>
								)}
								{messages.map((m, i) => (
									<ChatBubble
										// biome-ignore lint/suspicious/noArrayIndexKey: 追記のみの会話ログでindexが安定
										key={i}
										speaker={m.role}
										content={m.content}
									/>
								))}
								{pendingQuestion && (
									<>
										<ChatBubble speaker="user" content={pendingQuestion} />
										<p className="text-sm text-muted-foreground">考え中…</p>
									</>
								)}
							</div>

							{error && <p className="text-sm text-destructive">{error}</p>}
							{outOfCredits && (
								<p className="text-sm text-muted-foreground">
									今月のAIクレジットを使い切りました。翌月に付与されます。
								</p>
							)}

							<div className="flex items-end gap-2">
								<Textarea
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
											e.preventDefault();
											submit();
										}
									}}
									placeholder="質問を入力 (⌘/Ctrl+Enter で送信)"
									rows={2}
									className="resize-none"
									disabled={isPending || !!pendingQuestion}
								/>
								<Button type="button" disabled={!canSend} onClick={submit}>
									送信
								</Button>
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>

			<InsufficientCreditsDialog
				open={showInsufficient}
				onOpenChange={setShowInsufficient}
			/>
		</>
	);
}

function ChatBubble({
	speaker,
	content,
}: {
	speaker: "user" | "assistant";
	content: string;
}) {
	const isUser = speaker === "user";
	return (
		<div className={isUser ? "flex justify-end" : "flex justify-start"}>
			<div
				className={
					isUser
						? "max-w-[85%] whitespace-pre-line rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
						: "max-w-[85%] whitespace-pre-line rounded-lg bg-muted px-3 py-2 text-sm"
				}
			>
				{content}
			</div>
		</div>
	);
}
