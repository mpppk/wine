import { useState } from "react";
import { QuizQuestionView } from "#/components/quiz/QuizQuestionView";
import { useQuizSession } from "#/components/quiz/useQuizSession";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { QUIZ_TYPE_IDS, type QuizType } from "#/lib/quiz/types";
import type { Aop, RegionId } from "#/lib/wine/types";

// 地図ページ内で完結するクイズモーダル。scopeAop 指定時はそのAOPと階層近傍
// (親の村・配下の畑)、未指定時は地域全体から出題する。
// セッションはダイアログを閉じるとアンマウントで破棄され、再オープンや
// 「もう一度」(key の付け替え)で新しいセッションが始まる。

// 形式は絞らず全形式を対象にする(スコープ内で候補0件の形式は単に出題されない)
const ALL_QUIZ_TYPES: QuizType[] = [...QUIZ_TYPE_IDS];

export function MapQuizDialog({
	open,
	onOpenChange,
	regionId,
	regionNameJa,
	scopeAop,
	isAuthenticated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	regionId: RegionId;
	regionNameJa: string;
	/** 出題スコープの起点AOP。未指定なら地域全体 */
	scopeAop?: Aop;
	isAuthenticated: boolean;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[85dvh] flex-col gap-3 overflow-y-auto sm:max-w-lg"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle>
						{scopeAop ? scopeAop.nameJa : regionNameJa}のクイズ
					</DialogTitle>
				</DialogHeader>
				<QuizSessionBody
					regionId={regionId}
					scopeAopId={scopeAop?.id}
					isAuthenticated={isAuthenticated}
					onClose={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog>
	);
}

function QuizSessionBody({
	regionId,
	scopeAopId,
	isAuthenticated,
	onClose,
}: {
	regionId: RegionId;
	scopeAopId?: string;
	isAuthenticated: boolean;
	onClose: () => void;
}) {
	// 「もう一度」はセッション(フックの内部状態)ごと作り直したいので key で再マウント
	const [round, setRound] = useState(0);
	return (
		<SessionRound
			key={round}
			regionId={regionId}
			scopeAopId={scopeAopId}
			isAuthenticated={isAuthenticated}
			onRetry={() => setRound((r) => r + 1)}
			onClose={onClose}
		/>
	);
}

function SessionRound({
	regionId,
	scopeAopId,
	isAuthenticated,
	onRetry,
	onClose,
}: {
	regionId: RegionId;
	scopeAopId?: string;
	isAuthenticated: boolean;
	onRetry: () => void;
	onClose: () => void;
}) {
	const { phase, current, selectedOptionId, tally, answer, next } =
		useQuizSession(regionId, ALL_QUIZ_TYPES, isAuthenticated, scopeAopId);

	if (phase === "loading") {
		return (
			<div className="flex min-h-32 items-center justify-center">
				<p className="text-sm text-muted-foreground">問題を準備中…</p>
			</div>
		);
	}

	if (phase === "empty") {
		// 候補が少ないスコープでは一巡で出題が尽きる。1問でも解いていたら
		// 成績付きの完了メッセージにし、再挑戦(新セッション)を促す
		return (
			<div className="flex min-h-32 flex-col items-center justify-center gap-4">
				<p className="text-center text-sm text-muted-foreground">
					{tally.answered > 0
						? `この範囲の問題をひと通り解きました(${tally.answered}問中${tally.correct}問正解)`
						: "この範囲で出題できる問題がありません。"}
				</p>
				<div className="flex gap-2">
					{tally.answered > 0 && (
						<Button variant="outline" onClick={onRetry}>
							もう一度
						</Button>
					)}
					<Button variant="ghost" onClick={onClose}>
						閉じる
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				{tally.answered > 0
					? `${tally.answered}問中${tally.correct}問正解`
					: "セッション開始"}
			</p>
			{current && (
				<QuizQuestionView
					question={current}
					phase={phase}
					selectedOptionId={selectedOptionId}
					onAnswer={answer}
				/>
			)}
			{phase === "feedback" && (
				<Button onClick={next} size="lg" className="h-12 w-full text-base">
					次へ
				</Button>
			)}
		</div>
	);
}
