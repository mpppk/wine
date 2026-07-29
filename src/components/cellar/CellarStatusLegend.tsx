import { CollapsibleMapLegend } from "#/components/wine/CollapsibleMapLegend";
import { STATUS_COLORS } from "#/lib/drunk-wine/map-style";
import { WINE_STATUS_LABELS_JA, WINE_STATUSES } from "#/lib/drunk-wine/status";
import { MAP_LEGEND_KEYS } from "#/lib/map-legend";
import { cn } from "#/lib/utils";

const LEGEND_TITLE = "所有状態";

/** 状態1つ分の色見本。展開時(ラベル付き)と折りたたみ時(色だけ)で配色を共有する */
function StatusSwatch({
	status,
	className,
	title,
}: {
	status: (typeof WINE_STATUSES)[number]["id"];
	className?: string;
	title?: string;
}) {
	return (
		<span
			className={cn("inline-block shrink-0 rounded-sm border", className)}
			title={title}
			style={{
				backgroundColor: STATUS_COLORS[status].fill,
				borderColor: STATUS_COLORS[status].line,
			}}
		/>
	);
}

/**
 * マイセラー地図の所有状態の凡例。折りたたむと色見本だけの小さなチップに縮む
 * (開閉と永続化は CollapsibleMapLegend が持つ)。混在AOPは1色に畳んでいるので、
 * その旨を「すべて」表示のときだけ注記する(単一状態に絞れば混在自体が起きない)。
 */
export function CellarStatusLegend({
	showMixedNote,
	className,
}: {
	showMixedNote: boolean;
	className?: string;
}) {
	return (
		<CollapsibleMapLegend
			storageKey={MAP_LEGEND_KEYS.cellarStatus}
			title={LEGEND_TITLE}
			collapsedPreview={
				<span className="flex items-center gap-1">
					{WINE_STATUSES.map((s) => (
						<StatusSwatch
							key={s.id}
							status={s.id}
							className="size-2.5"
							title={WINE_STATUS_LABELS_JA[s.id]}
						/>
					))}
				</span>
			}
			className={cn("max-w-[15rem]", className)}
		>
			<ul className="flex flex-col gap-1">
				{WINE_STATUSES.map((s) => (
					<li key={s.id} className="flex items-center gap-1.5">
						<StatusSwatch status={s.id} className="size-3.5" />
						<span>{WINE_STATUS_LABELS_JA[s.id]}</span>
					</li>
				))}
			</ul>
			{showMixedNote && (
				<p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
					同じAOPに複数の状態があるときは
					{WINE_STATUS_LABELS_JA.owned}を優先して表示します。
				</p>
			)}
		</CollapsibleMapLegend>
	);
}
