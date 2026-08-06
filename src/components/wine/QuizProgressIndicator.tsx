import { CircleCheckIcon } from "lucide-react";
import type { AopProgress } from "#/lib/services/quiz-service";
import { cn } from "#/lib/utils";
import { PROGRESS_BUCKETS, PROGRESS_EMPTY_COLOR } from "#/lib/wine/map-style";

// AOPのクイズ正解進捗を示すピル。リストの各行(AopTreeList)と詳細パネルの
// クイズボタン(AopDetailPanel)が同じ見た目を共有するための単一の情報源。
// 行とパネルで別々に組むと、片方だけ「全問正解」の基準や表記が動いてドリフトする
// (#177/#185 の経路ごとの実装分岐と同じ轍)。

/** 進捗が「全問正解」か。総数0(候補問題なし)は完了扱いにしない */
export function isQuizComplete(progress: AopProgress | undefined): boolean {
	return !!progress && progress.total > 0 && progress.solved >= progress.total;
}

/**
 * 正解進捗を "solved/total" のピルで示す。全問正解済みはチェック+緑で強調する。
 * countOnly(未ログイン)時は正解が記録されず分数が動かないため、代わりに
 * そのスコープの出題数を「クイズN問」の中立ピルで示す。
 */
export function QuizProgressIndicator({
	progress,
	countOnly = false,
	className,
}: {
	progress: AopProgress;
	countOnly?: boolean;
	className?: string;
}) {
	const { solved, total } = progress;
	if (total <= 0) return null;
	if (countOnly) {
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center rounded border border-border px-1 text-[10px] tabular-nums text-muted-foreground",
					className,
				)}
			>
				クイズ{total}問
			</span>
		);
	}
	const complete = isQuizComplete(progress);
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] tabular-nums",
				complete
					? "border border-transparent font-medium text-white"
					: "border border-border text-muted-foreground",
				className,
			)}
			style={
				complete
					? {
							backgroundColor:
								PROGRESS_BUCKETS[PROGRESS_BUCKETS.length - 1]?.fill ??
								PROGRESS_EMPTY_COLOR.fill,
						}
					: undefined
			}
		>
			{complete && <CircleCheckIcon className="size-3" aria-hidden />}
			{/* 格付けバッジと隣り合うため、読み上げで "特級 12/20" が何の数かを示す */}
			<span className="sr-only">正解</span>
			{solved}/{total}
		</span>
	);
}
