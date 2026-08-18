import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "#/components/ui/dialog";

// 写真の拡大表示(ライトボックス)。マイセラーの閲覧画面で写真をタップすると開く。
//
// 非制御(自前で開閉 state を持つ)にしていないのは、開いた位置=タップした写真の
// index を呼び出し側が決めるため。閉じたら null を返して呼び出し側の state も畳む。

interface LightboxPhoto {
	/** 原寸の画像URL(サムネイルではなく拡大用) */
	src: string;
	alt: string;
}

export interface PhotoLightboxProps {
	photos: LightboxPhoto[];
	/** 表示中の写真の index。null で閉じる */
	openIndex: number | null;
	onOpenChange: (index: number | null) => void;
	/** ダイアログのアクセシブルな名前(読み上げ専用) */
	title: string;
}

export function PhotoLightbox({
	photos,
	openIndex,
	onOpenChange,
	title,
}: PhotoLightboxProps) {
	// 表示中の index はダイアログを開いている間だけ内部で動かす(前へ/次へ)。
	// 開き直したときは呼び出し側が渡した index に必ず戻す。
	const [index, setIndex] = useState(openIndex ?? 0);
	useEffect(() => {
		if (openIndex !== null) setIndex(openIndex);
	}, [openIndex]);

	const open = openIndex !== null && photos.length > 0;
	// 写真が減った直後(削除→戻る等)に範囲外を指しても落ちないようにする
	const current = photos[Math.min(index, photos.length - 1)];
	const multiple = photos.length > 1;
	const step = (dir: -1 | 1) =>
		setIndex((i) => (i + dir + photos.length) % photos.length);

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onOpenChange(null)}>
			<DialogContent
				// 画像を主役にするので枠と余白は最小限にし、縦横とも画面内に収める。
				// sm:max-w-lg(既定)だと拡大にならないので打ち消す。
				className="max-w-[calc(100%-1rem)] gap-2 p-2 sm:max-w-3xl"
				// 既定の閉じるボタンは画像に重なると同系色で見えなくなるため、
				// 背景付きの自前のボタンに差し替える
				showCloseButton={false}
				// 左右キーで送れるようにする(Esc での閉じは Radix が面倒を見る)
				onKeyDown={(e) => {
					if (!multiple) return;
					if (e.key === "ArrowLeft") {
						e.preventDefault();
						step(-1);
					} else if (e.key === "ArrowRight") {
						e.preventDefault();
						step(1);
					}
				}}
			>
				{/* ダイアログには名前と説明が要る(無いと Radix が警告する)。画面には出さない */}
				<DialogTitle className="sr-only">{title}</DialogTitle>
				<DialogDescription className="sr-only">
					写真を拡大表示しています。
					{multiple && "左右のボタンかキーで写真を切り替えられます。"}
					Escキーで閉じます。
				</DialogDescription>

				<DialogClose
					aria-label="閉じる"
					className="absolute right-4 top-4 z-10 rounded-full bg-background/80 p-2 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
				>
					<XIcon className="size-4" aria-hidden />
				</DialogClose>

				{current && (
					<img
						src={current.src}
						alt={current.alt}
						className="max-h-[75vh] w-full rounded-md object-contain"
						decoding="async"
					/>
				)}

				{multiple && (
					<div className="flex items-center justify-center gap-4">
						<Button
							type="button"
							variant="outline"
							size="icon"
							aria-label="前の写真"
							onClick={() => step(-1)}
						>
							<ChevronLeftIcon className="size-4" />
						</Button>
						<span className="text-sm tabular-nums text-muted-foreground">
							{Math.min(index, photos.length - 1) + 1} / {photos.length}
						</span>
						<Button
							type="button"
							variant="outline"
							size="icon"
							aria-label="次の写真"
							onClick={() => step(1)}
						>
							<ChevronRightIcon className="size-4" />
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
