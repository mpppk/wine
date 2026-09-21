import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HistoryIcon, PlusIcon, SparklesIcon } from "lucide-react";
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
import { LiveRegion } from "#/components/ui/live-region";
import { Textarea } from "#/components/ui/textarea";
import {
	CREDIT_BALANCE_QUERY_KEY,
	useCreditBalanceValue,
} from "#/lib/credit/use-credit";
import type {
	ChatMessageView,
	ChatRunView,
	ConversationSummary,
} from "#/lib/services/ai-conversation-service";
import { getRegion } from "#/lib/wine/regions";
import {
	deleteAiConversation,
	getAiConversation,
	listAiConversations,
	retryAiChat,
	sendAiChat,
} from "#/server/ai";
import { useStickToBottom } from "./use-stick-to-bottom";

// 地図ページ内の地域チャットQ&A(Issue #603)。会話はD1に永続化し、
// 履歴一覧から再開できる。ブラウザは質問・会話ID・送信IDだけを送り、
// 履歴本文は送らない(所有者は認証コンテキストから決める)。
//
// - ダイアログを開いただけでは空の会話を作らず、最初の送信で作成する
// - 会話の地域・AOPは作成時の文脈として固定し、別文脈では引き継がない
// - 生成中の削除は競合エラーになり、完了または中断確定後に削除できる
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
	const [view, setView] = useState<"chat" | "history">("chat");
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [regionFilter, setRegionFilter] = useState<"current" | "all">(
		"current",
	);
	const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const [showInsufficient, setShowInsufficient] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

	// 地域・AOPの切り替えでは親が key で作り直すため、ここで文脈の追従はしない。
	// 開いた会話の地域・AOPは作成時の文脈として固定する(#603)。

	const historyQuery = useQuery({
		queryKey: ["ai-conversations", regionId, regionFilter],
		queryFn: () =>
			listAiConversations({
				data: {
					...(regionFilter === "current" ? { regionId } : {}),
				},
			}),
		enabled: open && view === "history" && isAuthenticated,
	});

	const detailQuery = useQuery({
		queryKey: ["ai-conversation", conversationId],
		queryFn: () =>
			getAiConversation({ data: { conversationId: conversationId as string } }),
		enabled: open && conversationId !== null && isAuthenticated,
		// 生成が続いていれば状態を取得する(自動再実行はしない)。
		// 完了していれば保存回答が返る。
		refetchInterval: (query) => {
			const runs = query.state.data?.runs ?? [];
			return runs.some((r) => r.status === "running") ? 5000 : false;
		},
	});

	const detail = detailQuery.data ?? null;
	const messages = detail?.messages ?? [];
	const runs = detail?.runs ?? [];
	const hasRunningRun = runs.some((r) => r.status === "running");
	// 履歴から別地域の会話を開いた場合は、その会話へ送信しない。
	const contextMismatch =
		detail !== null &&
		(detail.regionId !== regionId || (detail.aopId ?? undefined) !== aopId);

	// 新着(質問の送信・回答の到着)で会話ログを最下部へ追従させる(#242)。
	// クレジットを消費する操作なので、送っても画面が変わらない=無反応に見える状態を作らない。
	const log = useStickToBottom<HTMLDivElement>(
		`${open}:${view}:${messages.length}:${pendingQuestion ? 1 : 0}`,
	);

	const invalidateChat = (id: string | null) => {
		if (id) {
			void queryClient.invalidateQueries({
				queryKey: ["ai-conversation", id],
			});
		}
		void queryClient.invalidateQueries({ queryKey: ["ai-conversations"] });
	};

	const handleSendResult = (result: Awaited<ReturnType<typeof sendAiChat>>) => {
		void queryClient.invalidateQueries({
			queryKey: CREDIT_BALANCE_QUERY_KEY,
		});
		setPendingQuestion(null);
		setConversationId(result.conversationId);
		invalidateChat(result.conversationId);
		if (result.status === "ok") {
			setError("");
			return;
		}
		if (result.status === "pending") {
			setError("回答を生成中です。そのままお待ちください。");
			return;
		}
		if (result.status === "blocked") {
			if ("balance" in result) {
				setShowInsufficient(true);
			} else {
				setError("AIクレジットが不足しています。再試行してください。");
			}
			return;
		}
		setError("回答の生成に失敗しました。再試行できます。");
	};

	const sendMutation = useMutation({
		mutationFn: (vars: { question: string; sendId: string }) =>
			sendAiChat({
				data: {
					conversationId,
					regionId,
					aopId,
					question: vars.question,
					sendId: vars.sendId,
				},
			}),
		onSuccess: handleSendResult,
		onError: (e: Error) => {
			setPendingQuestion(null);
			setError(e.message || "回答の生成に失敗しました。");
			invalidateChat(conversationId);
		},
	});

	const retryMutation = useMutation({
		mutationFn: (vars: { runId: string; sendId: string }) => {
			if (!conversationId) throw new Error("会話が選択されていません。");
			return retryAiChat({
				data: {
					conversationId,
					runId: vars.runId,
					sendId: vars.sendId,
				},
			});
		},
		onSuccess: handleSendResult,
		onError: (e: Error) => {
			setError(e.message || "再試行に失敗しました。");
			invalidateChat(conversationId);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (vars: { id: string }) =>
			deleteAiConversation({ data: { conversationId: vars.id } }),
		onSuccess: (_, vars) => {
			setDeleteTarget(null);
			if (vars.id === conversationId) {
				setConversationId(null);
			}
			invalidateChat(vars.id);
		},
		onError: (e: Error) => {
			setDeleteTarget(null);
			setError(e.message || "削除に失敗しました。");
		},
	});

	const trimmed = input.trim();
	// 直近のAI回答。読み上げ用のライブリージョンに載せる(#239)
	const last = messages[messages.length - 1];
	const lastAnswer = last?.role === "assistant" ? last.content : null;
	const outOfCredits = balance !== null && balance <= 0;
	const busy = sendMutation.isPending || retryMutation.isPending;
	const canSend =
		isAuthenticated &&
		!!trimmed &&
		!busy &&
		!pendingQuestion &&
		!outOfCredits &&
		!hasRunningRun &&
		!contextMismatch;

	const submit = () => {
		if (!canSend) return;
		const question = trimmed;
		setInput("");
		setError("");
		setPendingQuestion(question);
		// 送信IDは送信アクションごとに採番する。同一送信IDの再送は
		// 再推論・再課金せず保存結果を返す(冪等)。
		sendMutation.mutate({ question, sendId: crypto.randomUUID() });
	};

	const retry = (runId: string) => {
		setError("");
		retryMutation.mutate({ runId, sendId: crypto.randomUUID() });
	};

	const openHistory = (id: string) => {
		setConversationId(id);
		setView("chat");
		setError("");
		setPendingQuestion(null);
	};

	const startNew = () => {
		setConversationId(null);
		setView("chat");
		setError("");
		setPendingQuestion(null);
	};

	const title = detail
		? detail.title
		: (aopNameJa ?? `${regionNameJa} について質問`);

	const regionLabel = (id: string) => getRegion(id)?.nameJa ?? id;

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
							<span className="truncate">{title}</span>
						</DialogTitle>
						<DialogDescription>
							この地域のデータをもとにAIが回答します。1回の回答でAIクレジットを消費します。
							長い会話では直近の往復のみを参照します。
						</DialogDescription>
						{isAuthenticated && (
							<div className="flex items-center gap-2 pt-1">
								<Button
									type="button"
									variant={view === "chat" ? "secondary" : "ghost"}
									size="sm"
									onClick={startNew}
								>
									<PlusIcon className="size-4" aria-hidden />
									新しい会話
								</Button>
								<Button
									type="button"
									variant={view === "history" ? "secondary" : "ghost"}
									size="sm"
									onClick={() => setView("history")}
								>
									<HistoryIcon className="size-4" aria-hidden />
									履歴
								</Button>
							</div>
						)}
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
					) : view === "history" ? (
						<div className="flex min-h-32 flex-1 flex-col gap-3 overflow-y-auto">
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant={regionFilter === "current" ? "secondary" : "ghost"}
									size="sm"
									onClick={() => setRegionFilter("current")}
								>
									{regionNameJa}
								</Button>
								<Button
									type="button"
									variant={regionFilter === "all" ? "secondary" : "ghost"}
									size="sm"
									onClick={() => setRegionFilter("all")}
								>
									すべての地域
								</Button>
							</div>
							{historyQuery.isPending ? (
								<p className="py-6 text-center text-sm text-muted-foreground">
									履歴を読み込んでいます…
								</p>
							) : historyQuery.isError ? (
								<p className="py-6 text-center text-sm text-destructive">
									履歴の読み込みに失敗しました。
								</p>
							) : (historyQuery.data?.items.length ?? 0) === 0 ? (
								<p className="py-6 text-center text-sm text-muted-foreground">
									まだ会話がありません。最初の質問を送るとここに保存されます。
								</p>
							) : (
								historyQuery.data?.items.map((c: ConversationSummary) => (
									<div
										key={c.id}
										className="flex items-center gap-2 rounded-lg border px-3 py-2"
									>
										<button
											type="button"
											className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
											onClick={() => openHistory(c.id)}
										>
											<span className="w-full truncate text-sm font-medium">
												{c.title}
											</span>
											<span className="text-xs text-muted-foreground">
												{regionLabel(c.regionId)}・
												{new Date(c.updatedAtMs).toLocaleString("ja-JP", {
													dateStyle: "short",
													timeStyle: "short",
												})}
											</span>
										</button>
										{deleteTarget === c.id ? (
											<span className="flex shrink-0 items-center gap-1">
												<Button
													type="button"
													variant="destructive"
													size="sm"
													disabled={deleteMutation.isPending}
													onClick={() => deleteMutation.mutate({ id: c.id })}
												>
													削除する
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() => setDeleteTarget(null)}
												>
													やめる
												</Button>
											</span>
										) : (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => setDeleteTarget(c.id)}
											>
												削除
											</Button>
										)}
									</div>
								))
							)}
							{historyQuery.data?.nextCursor && (
								<p className="text-center text-xs text-muted-foreground">
									古い履歴は次回以降の拡張でページングします。
								</p>
							)}
						</div>
					) : (
						<>
							{contextMismatch && (
								<p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
									別の地域の会話を開いています。このまま読むことはできますが、
									続きを質問するには新しい会話を始めてください。
								</p>
							)}
							<div
								ref={log.ref}
								onScroll={log.onScroll}
								className="flex min-h-32 flex-1 flex-col gap-3 overflow-y-auto"
							>
								{detailQuery.isPending && conversationId !== null ? (
									<p className="py-6 text-center text-sm text-muted-foreground">
										会話を読み込んでいます…
									</p>
								) : (
									<>
										{messages.length === 0 && !pendingQuestion && (
											<p className="py-6 text-center text-sm text-muted-foreground">
												例:「主なブドウ品種は?」「どんな土壌?」など、この地域について質問できます。
											</p>
										)}
										{messages.map((m: ChatMessageView) => {
											const failedRun = runs.find(
												(r: ChatRunView) =>
													r.retryable &&
													r.userSequence === m.sequence &&
													m.role === "user",
											);
											return (
												<div key={m.id} className="flex flex-col gap-1">
													<ChatBubble speaker={m.role} content={m.content} />
													{failedRun && (
														<div className="flex justify-end">
															<Button
																type="button"
																variant="outline"
																size="sm"
																disabled={busy || hasRunningRun}
																onClick={() => retry(failedRun.id)}
															>
																再試行
															</Button>
														</div>
													)}
												</div>
											);
										})}
										{pendingQuestion && (
											<ChatBubble speaker="user" content={pendingQuestion} />
										)}
										{/*
										  送信後の「考え中…」と回答の到着を読み上げる(#239)。会話ログ自体は
										  ライブリージョンにしない(履歴が変わるたび全部読み上げてしまう)。
										  クレジットを消費する操作なので、無反応に見えないことが要る。
										*/}
										<LiveRegion className="empty:-mt-3">
											{pendingQuestion || hasRunningRun ? (
												<p className="text-sm text-muted-foreground">考え中…</p>
											) : (
												// 回答は画面上は吹き出しに出ているので、読み上げ用にだけ複製する
												lastAnswer && <p className="sr-only">{lastAnswer}</p>
											)}
										</LiveRegion>
									</>
								)}
							</div>

							{/* エラーは対処が要るので assertive。空でもコンテナは残す */}
							<LiveRegion tone="alert" className="empty:-mt-3">
								{error && <p className="text-sm text-destructive">{error}</p>}
							</LiveRegion>
							{outOfCredits && (
								<p className="text-sm text-muted-foreground">
									今月のAIクレジットを使い切りました。翌月に付与されます。
								</p>
							)}
							{hasRunningRun && (
								<div className="flex items-center gap-2">
									<p className="text-sm text-muted-foreground">生成中です…</p>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => detailQuery.refetch()}
									>
										状態を更新
									</Button>
								</div>
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
									disabled={busy || !!pendingQuestion || hasRunningRun}
								/>
								<Button type="button" disabled={!canSend} onClick={submit}>
									送信
								</Button>
							</div>
							{conversationId !== null && (
								<div className="flex justify-end">
									{deleteTarget === conversationId ? (
										<span className="flex items-center gap-1 text-sm">
											<span className="text-muted-foreground">
												この会話を削除しますか?
											</span>
											<Button
												type="button"
												variant="destructive"
												size="sm"
												disabled={deleteMutation.isPending}
												onClick={() =>
													deleteMutation.mutate({ id: conversationId })
												}
											>
												削除する
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => setDeleteTarget(null)}
											>
												やめる
											</Button>
										</span>
									) : (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => setDeleteTarget(conversationId)}
										>
											この会話を削除
										</Button>
									)}
								</div>
							)}
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
