import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";
import { PhotoBoxOverlay } from "#/components/cellar/BoxedPhoto";
import { Button } from "#/components/ui/button";
import {
	defaultPhotoBox,
	growPhotoBox,
	movePhotoBox,
	type PhotoBox,
	type PhotoBoxCorner,
	resizePhotoBox,
} from "#/lib/drunk-wine/photo-box";
import { cn } from "#/lib/utils";

// 一括登録のレビュー画面で、写真の中の「その銘柄があった枠」を手直しするエディタ
// (Issue #693)。枠の移動・角でのリサイズ・削除・新規作成ができる。
//
// 座標は表示中の画像に対する比率(0〜1)で扱う。外枠を画像の表示寸法に合わせて
// あるので、ポインタ位置を外枠の矩形で割るだけで比率になる(画像の原寸を測らない)。
// 幾何(はみ出し・最小サイズ・裏返り防止)は `photo-box.ts` の純関数が持つ。
//
// キーボード: 枠にフォーカスして矢印キーで移動、Shift+矢印で大きさを変える。

/** キー操作1回の移動量(比率)。 */
const KEY_STEP = 0.01;

const CORNERS: { corner: PhotoBoxCorner; className: string; label: string }[] =
	[
		{
			corner: "top-left",
			className: "-left-2 -top-2 cursor-nwse-resize",
			label: "左上",
		},
		{
			corner: "top-right",
			className: "-right-2 -top-2 cursor-nesw-resize",
			label: "右上",
		},
		{
			corner: "bottom-left",
			className: "-bottom-2 -left-2 cursor-nesw-resize",
			label: "左下",
		},
		{
			corner: "bottom-right",
			className: "-bottom-2 -right-2 cursor-nwse-resize",
			label: "右下",
		},
	];

/** ドラッグ中の操作。開始時の枠とポインタ位置からの差分で計算する。 */
type DragState =
	| { kind: "move"; start: PhotoBox; x: number; y: number }
	| { kind: "resize"; corner: PhotoBoxCorner };

export interface PhotoBoxEditorProps {
	src: string;
	alt: string;
	box: PhotoBox | null;
	onChange: (box: PhotoBox | null) => void;
	imgClassName?: string;
}

export function PhotoBoxEditor({
	src,
	alt,
	box,
	onChange,
	imgClassName,
}: PhotoBoxEditorProps) {
	const frameRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<DragState | null>(null);

	/** ポインタ位置を、表示中の画像に対する比率へ。 */
	const toRatio = (e: React.PointerEvent) => {
		const rect = frameRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0 || rect.height === 0) return null;
		return {
			x: (e.clientX - rect.left) / rect.width,
			y: (e.clientY - rect.top) / rect.height,
		};
	};

	const startDrag = (e: React.PointerEvent, state: DragState) => {
		e.preventDefault();
		e.stopPropagation();
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		dragRef.current = state;
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const drag = dragRef.current;
		if (!drag || !box) return;
		const p = toRatio(e);
		if (!p) return;
		if (drag.kind === "move") {
			onChange(movePhotoBox(drag.start, p.x - drag.x, p.y - drag.y));
		} else {
			onChange(resizePhotoBox(box, drag.corner, p.x, p.y));
		}
	};

	const endDrag = (e: React.PointerEvent) => {
		if (!dragRef.current) return;
		dragRef.current = null;
		(e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (!box) return;
		const delta: Record<string, [number, number]> = {
			ArrowLeft: [-KEY_STEP, 0],
			ArrowRight: [KEY_STEP, 0],
			ArrowUp: [0, -KEY_STEP],
			ArrowDown: [0, KEY_STEP],
		};
		const d = delta[e.key];
		if (!d) return;
		e.preventDefault();
		// ライトボックスの左右キー(写真送り)へ伝えない。
		e.stopPropagation();
		onChange(
			e.shiftKey
				? growPhotoBox(box, d[0], d[1])
				: movePhotoBox(box, d[0], d[1]),
		);
	};

	return (
		<div className="flex flex-col items-center gap-2">
			<div
				ref={frameRef}
				className="relative mx-auto w-fit max-w-full touch-none select-none"
			>
				<img
					src={src}
					alt={alt}
					draggable={false}
					decoding="async"
					className={cn("block", imgClassName)}
				/>
				{box && (
					<>
						<PhotoBoxOverlay box={box} />
						{/* 操作用の透明な枠。見た目は PhotoBoxOverlay が描く */}
						<div
							role="slider"
							tabIndex={0}
							aria-label="銘柄の枠"
							aria-valuetext={`左 ${Math.round(box.left * 100)}%、上 ${Math.round(box.top * 100)}%、幅 ${Math.round((box.right - box.left) * 100)}%、高さ ${Math.round((box.bottom - box.top) * 100)}%`}
							aria-valuenow={Math.round(box.left * 100)}
							aria-valuemin={0}
							aria-valuemax={100}
							className="absolute cursor-move outline-none focus-visible:ring-2 focus-visible:ring-ring"
							style={{
								left: `${box.left * 100}%`,
								top: `${box.top * 100}%`,
								width: `${(box.right - box.left) * 100}%`,
								height: `${(box.bottom - box.top) * 100}%`,
							}}
							onKeyDown={onKeyDown}
							onPointerDown={(e) => {
								const p = toRatio(e);
								if (p) startDrag(e, { kind: "move", start: box, ...p });
							}}
							onPointerMove={onPointerMove}
							onPointerUp={endDrag}
							onPointerCancel={endDrag}
						>
							{CORNERS.map(({ corner, className, label }) => (
								<span
									key={corner}
									aria-hidden
									data-corner={label}
									className={cn(
										"absolute size-4 rounded-full border-2 border-black/60 bg-yellow-400",
										className,
									)}
									onPointerDown={(e) =>
										startDrag(e, { kind: "resize", corner })
									}
									onPointerMove={onPointerMove}
									onPointerUp={endDrag}
									onPointerCancel={endDrag}
								/>
							))}
						</div>
					</>
				)}
			</div>
			<div className="flex flex-wrap items-center justify-center gap-2">
				{box ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onChange(null)}
					>
						<Trash2Icon className="size-4" aria-hidden />
						枠を削除
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onChange(defaultPhotoBox())}
					>
						<PlusIcon className="size-4" aria-hidden />
						枠を追加
					</Button>
				)}
				<span className="text-xs text-muted-foreground">
					{box
						? "枠をドラッグで移動、角をドラッグで大きさを変更できます"
						: "この写真には枠がありません"}
				</span>
			</div>
		</div>
	);
}
