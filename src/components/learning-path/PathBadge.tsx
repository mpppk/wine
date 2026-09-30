import type { RegionPathStatus } from "#/lib/dashboard/learning-path";
import { cn } from "#/lib/utils";

// 学習パス(/regions・/quiz 共用)の現在地/次/完了バッジ。
// 進捗はログイン時のみ分かるため、step が無い場合は何も出さない。
// 自由選択を阻害しないよう、バッジは表示だけで遷移先・選択肢は変えない(#207)。

const LABEL: Record<RegionPathStatus, string> = {
	current: "学習中",
	next: "次におすすめ",
	done: "完了",
};

export function PathBadge({
	status,
	className,
}: {
	status: RegionPathStatus | null;
	className?: string;
}) {
	if (!status) return null;
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
				status === "done" &&
					"bg-green-500/10 text-green-700 dark:text-green-400",
				status === "current" && "bg-primary/10 text-primary",
				status === "next" &&
					"bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
				className,
			)}
		>
			{LABEL[status]}
		</span>
	);
}
