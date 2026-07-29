import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
	isMapLegendCollapsed,
	type MapLegendKey,
	setMapLegendCollapsed,
} from "#/lib/map-legend";
import { cn } from "#/lib/utils";

/**
 * 地図に重ねる凡例の共通シェル。閉じると `collapsedPreview` だけの小さなボタンに縮み、
 * その状態は端末に記憶される(次回以降は最初から縮んだ状態で出る)。色の意味は一度
 * 理解すれば見ないため、常時パネルを出して地図のラベルを隠さないようにする。
 *
 * AOP地図(進捗モード)とマイセラー地図(所有状態)の両方がこれを使う。開閉・永続化・
 * ラベル付けを1箇所に置き、凡例ごとに中身(スウォッチの並べ方)だけを差し替える。
 */
export function CollapsibleMapLegend({
	storageKey,
	title,
	collapsedPreview,
	children,
	className,
}: {
	storageKey: MapLegendKey;
	/** 見出し。折りたたみボタンの aria-label にも使う */
	title: string;
	/** 折りたたみ時に見せる最小限の手がかり(ラベル無しのスウォッチ列など) */
	collapsedPreview: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	// SSR/ハイドレーション時は localStorage を読めないので未判定(null)から始め、
	// マウント後に確定させる。地図自体がクライアントでしか描画されないため1フレーム
	// 遅れて出ても体感差はなく、閉じた人に展開状態が一瞬見えるのを防げる。
	const [open, setOpen] = useState<boolean | null>(null);

	useEffect(() => {
		setOpen(!isMapLegendCollapsed(storageKey));
	}, [storageKey]);

	if (open === null) return null;

	const toggle = (next: boolean) => {
		setOpen(next);
		setMapLegendCollapsed(storageKey, !next);
	};

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => toggle(true)}
				aria-expanded={false}
				aria-label={`${title}の凡例を表示`}
				title={`${title}の凡例を表示`}
				className={cn(
					"z-10 rounded-md border border-border bg-background/80 px-1.5 py-1 text-xs shadow-sm backdrop-blur transition-colors hover:bg-background",
					className,
				)}
			>
				{collapsedPreview}
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
				<span className="font-medium">{title}</span>
				<button
					type="button"
					onClick={() => toggle(false)}
					aria-expanded
					aria-label={`${title}の凡例を閉じる`}
					title={`${title}の凡例を閉じる`}
					className="-mr-1.5 ml-auto rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" aria-hidden />
				</button>
			</div>
			{children}
		</div>
	);
}
