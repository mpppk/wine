import { GlobeIcon } from "lucide-react";
import { cn } from "#/lib/utils";

// WEB由来の写真であることを示す共通バッジ(IMPL-4)。
//
// web で見つけたボトル/エチケット画像は別ヴィンテージ・別キュヴェのことがあり、
// 写真と実物が違うことを黙って隠さないために、使う場所すべてで同じ見た目・
// 同じ文言で由来を示す。ギャラリー(`WinePhotoGallery`)・1枚表示
// (`ZoomablePhoto`)・レビューカード(`ImportCandidateCard`)の3箇所がこの1点を
// 使う(表示ドリフト防止)。文言は従来の「web画像を取得」から「WEB」に統一する。

export interface WebPhotoBadgeProps {
	/**
	 * - `overlay`: 画像の左上に重ねる(親に `relative` が要る)。画像ボタンの
	 *   アクセシブル名に由来を含めるため、バッジ自体は読み上げない
	 * - `inline`: 文字バッジの列に並べる(従来の「web画像を取得」の置き換え)
	 */
	variant: "overlay" | "inline";
	className?: string;
}

export function WebPhotoBadge({ variant, className }: WebPhotoBadgeProps) {
	if (variant === "overlay") {
		return (
			<span
				aria-hidden
				className={cn(
					"pointer-events-none absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white",
					className,
				)}
			>
				<GlobeIcon className="size-3" aria-hidden />
				WEB
			</span>
		);
	}
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
				className,
			)}
		>
			<GlobeIcon className="size-3" aria-hidden />
			WEB画像
		</span>
	);
}
