import { MAP_LEGEND_KEYS } from "#/lib/map-legend";
import { cn } from "#/lib/utils";
import { PROGRESS_BUCKETS, PROGRESS_EMPTY_COLOR } from "#/lib/wine/map-style";
import { CollapsibleMapLegend } from "./CollapsibleMapLegend";

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

/** AOP地図の進捗モード(クイズ正解率)の凡例。折りたたむとカラースケールだけに縮む */
export function MapProgressLegend({ className }: { className?: string }) {
	return (
		<CollapsibleMapLegend
			storageKey={MAP_LEGEND_KEYS.progress}
			title={LEGEND_TITLE}
			collapsedPreview={
				<ProgressLegendScale swatchClassName="size-2.5" className="gap-1" />
			}
			className={className}
		>
			<ProgressLegendScale />
		</CollapsibleMapLegend>
	);
}
