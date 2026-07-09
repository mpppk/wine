import { StarIcon } from "lucide-react";
import { cn } from "#/lib/utils";

/** 星1-5の読み取り専用表示(一覧・地図パネル共用) */
export function RatingStars({ rating }: { rating: number }) {
	return (
		<span
			className="inline-flex items-center gap-0.5"
			role="img"
			aria-label={`評価 星${rating}`}
		>
			{[1, 2, 3, 4, 5].map((n) => (
				<StarIcon
					key={n}
					className={cn(
						"size-3.5",
						n <= rating
							? "fill-amber-400 text-amber-400"
							: "text-muted-foreground/30",
					)}
					aria-hidden
				/>
			))}
		</span>
	);
}
