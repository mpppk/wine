import { RotateCcwIcon, SkipForwardIcon } from "lucide-react";
import { useState } from "react";
import {
	AdInterstitialDialog,
	useQuizAdInterstitial,
} from "#/components/ads/AdInterstitialDialog";
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
	} = useQuizSession(regionId, ALL_QUIZ_TYPES, isAuthenticated, scopeAopId);
	// 10問回答ごとに「次へ」へ広告を割り込ませる(無料会員のみ)。/quiz/play と同じ挙動
	const { adOpen, onAdOpenChange, nextWithAd } = useQuizAdInterstitial(
		tally.answered,
		next,
	);

	if (phase === "loading") {
		return (
			<div className="flex min-h-32 items-center justify-center">
				<p className="text-sm text-muted-foreground">問題を準備中…</p>
			</div>
		);
	}

	if (phase === "done") {
		// この範囲の未正解を全問正解した。未ログインは「もう一度」で新セッション
		// (実績が残らないので再挑戦できる)。ログインは正解済みが除外され即完了に
		// なるため出さない。
		return (
			<div className="flex min-h-32 flex-col items-center justify-center gap-4 text-center">
				<p className="text-3xl" aria-hidden>
					🎉
				</p>
				<p className="text-sm font-medium">
					{tally.answered > 0
						? `全問正解しました！(${tally.answered}問中${tally.correct}問正解)`
						: "この範囲はすべて正解済みです"}
				</p>
				<div className="flex gap-2">
					{tally.answered > 0 && !isAuthenticated && (
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

	if (phase === "empty") {
		return (
			<div className="flex min-h-32 flex-col items-center justify-center gap-4">
				<p className="text-center text-sm text-muted-foreground">
					この範囲で出題できる問題がありません。
				</p>
				<Button variant="ghost" onClick={onClose}>
					閉じる
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				{remaining !== null && `残り${remaining}問 ・ `}
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
			{phase === "answering" && (
				<Button
					onClick={skip}
					variant="ghost"
					size="lg"
					className="h-12 w-full text-base text-muted-foreground"
				>
					<SkipForwardIcon className="size-4" aria-hidden />
					スキップ
				</Button>
			)}
			{phase === "feedback" && (
				<div className="flex gap-2">
					<Button
						onClick={reset}
						variant="outline"
						size="lg"
						className="h-12 text-base"
					>
						<RotateCcwIcon className="size-4" aria-hidden />
						回答を取り消す
					</Button>
					<Button
						onClick={nextWithAd}
						size="lg"
						className="h-12 flex-1 text-base"
					>
						次へ
					</Button>
				</div>
			)}

			{/* クイズダイアログの上に重ねる(Radixのネストダイアログ) */}
			<AdInterstitialDialog open={adOpen} onOpenChange={onAdOpenChange} />
		</div>
	);
}
