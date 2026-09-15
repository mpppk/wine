import { StarIcon } from "lucide-react";
import { cn } from "#/lib/utils";

/**
 * 評価 ★1–5 の入力。押した星をもう一度押すと取り消し(null)になる。
 *
 * TastingFields(飲用記録・MCP App・一括登録)と EncounterFields(体験記録)で
 * 共有する——経路ごとに書き直すと星の挙動・見た目がずれる。
 */
export function RatingStarsInput({
	value,
	onChange,
	disabled,
	labelPrefix = "星",
}: {
	value: number | null;
	onChange: (rating: number | null) => void;
	disabled?: boolean;
	labelPrefix?: string;
}) {
	return (
		<div className="flex h-9 items-center gap-0.5">
			{[1, 2, 3, 4, 5].map((n) => {
				const active = value !== null && n <= value;
				return (
					<button
						key={n}
						type="button"
						aria-label={`${labelPrefix}${n}`}
						aria-pressed={value === n}
						disabled={disabled}
						onClick={() => onChange(value === n ? null : n)}
						className="rounded-sm p-1 transition-transform hover:scale-110 focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none disabled:opacity-50"
					>
						<StarIcon
							className={cn(
								"size-6",
								active
									? "fill-amber-400 text-amber-400"
									: "text-muted-foreground/40",
							)}
							aria-hidden
						/>
					</button>
				);
			})}
		</div>
	);
}
