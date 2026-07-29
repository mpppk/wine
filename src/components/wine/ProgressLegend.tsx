import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { PROGRESS_BUCKETS, PROGRESS_EMPTY_COLOR } from "#/lib/wine/map-style";
import {
	isProgressLegendCollapsed,
	setProgressLegendCollapsed,
} from "#/lib/wine/progress-legend";

const LEGEND_TITLE = "クイズ正解率";

/**
 * 「少 □■■■■ 多」のカラースケール行。展開時と折りたたみ時で同じ配色・同じ並びを
 * 共有する(スウォッチの大きさだけを変える)。
 */
function ProgressLegendScale({
	swatchClassName = "size-3.5",
	className,
}: {
	swatchClassName?: string;
	className?: string;
}) {
	return (
		<span className={cn("flex items-center gap-1.5", className)}>
			<span className="text-muted-foreground">少</span>
			<span
				className={cn("inline-block rounded-sm", swatchClassName)}
				style={{ backgroundColor: PROGRESS_EMPTY_COLOR.fill }}
				title="未正解"
			/>
			{PROGRESS_BUCKETS.map((b) => (
				<span
					key={b.fill}
					className={cn("inline-block rounded-sm", swatchClassName)}
					style={{ backgroundColor: b.fill }}
				/>
			))}
			<span className="text-muted-foreground">多</span>
		</span>
	);
}

/**
 * 地図に重ねる進捗モードの凡例。閉じるとカラースケールだけの小さなボタンに縮み、
 * その状態は端末に記憶される(次回以降は最初から縮んだ状態で出る)。色の意味は
 * 一度理解すれば見ないため、常時パネルを出して地図のラベルを隠さないようにする。
 */
export function MapProgressLegend({ className }: { className?: string }) {
	// SSR/ハイドレーション時は localStorage を読めないので未判定(null)から始め、
	// マウント後に確定させる。地図自体がクライアントでしか描画されないため1フレーム
	// 遅れて出ても体感差はなく、閉じた人に展開状態が一瞬見えるのを防げる。
	const [open, setOpen] = useState<boolean | null>(null);

	useEffect(() => {
		setOpen(!isProgressLegendCollapsed());
	}, []);

	if (open === null) return null;

	const toggle = (next: boolean) => {
		setOpen(next);
		setProgressLegendCollapsed(!next);
	};

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => toggle(true)}
				aria-expanded={false}
				aria-label={`${LEGEND_TITLE}の凡例を表示`}
				title={`${LEGEND_TITLE}の凡例を表示`}
				className={cn(
					"z-10 rounded-md border border-border bg-background/80 px-1.5 py-1 text-xs shadow-sm backdrop-blur transition-colors hover:bg-background",
					className,
				)}
			>
				<ProgressLegendScale swatchClassName="size-2.5" className="gap-1" />
			</button>
		);
	}

	return (
		<div
			className={cn(
				"z-10 rounded-md border border-border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur",
				className,
			)}
		>
			<div className="mb-1 flex items-center gap-1">
				<span className="font-medium">{LEGEND_TITLE}</span>
				<button
					type="button"
					onClick={() => toggle(false)}
					aria-expanded
					aria-label="凡例を閉じる"
					title="凡例を閉じる"
					className="-mr-1.5 ml-auto rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" aria-hidden />
				</button>
			</div>
			<ProgressLegendScale />
		</div>
	);
}
