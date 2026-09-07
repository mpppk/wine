import { GlobeIcon } from "lucide-react";
import { cn } from "#/lib/utils";

// WEB由来の写真であることを示す共通バッジ(IMPL-4)。
//
// web で見つけたボトル/エチケット画像は別ヴィンテージ・別キュヴェのことがあり、
// 写真と実物が違うことを黙って隠さないために、使う場所すべてで同じ見た目・
// 同じ文言で由来を示す。ギャラリー(`WinePhotoGallery`)・1枚表示
// (`ZoomablePhoto`)がこの1点を使う(表示ドリフト防止)。レビューカードの文字
// バッジは廃止し、由来表示は画像左上の overlay に一本化した。

export interface WebPhotoBadgeProps {
	/**
	 * 画像の左上に重ねる(親に `relative` が要る)。画像ボタンの
	 * アクセシブル名に由来を含めるため、バッジ自体は読み上げない。
	 */
	variant: "overlay";
	className?: string;
}

export function WebPhotoBadge({ className }: WebPhotoBadgeProps) {
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
