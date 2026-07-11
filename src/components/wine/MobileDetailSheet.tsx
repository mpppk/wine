import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";
import { cn } from "#/lib/utils";

// スワイプ量がこれを超えて離すと閉じる。超えなければ元位置へ戻す。
const DISMISS_THRESHOLD_PX = 100;
// これ以上動いたら「タップ」ではなく「ドラッグ」とみなし、release後のclickを無視する。
const DRAG_SLOP_PX = 6;

/**
 * モバイルの下部詳細パネル(ボトムシート)ラッパー。最上部中央のハンドルを持って
 * 下スワイプすると閉じる(Notion等と同じ挙動)。非タッチ環境向けにハンドルの
 * タップ/クリック/キーボード(Enter/Space)でも閉じられる。
 *
 * 構造は「固定ハンドル + スクロールする本文」。外側divは overflow-hidden とし、
 * children は内側の overflow-y-auto に入れることでスクロールしてもハンドルは
 * 上部に固定される。ドラッグはハンドル上でのみ受け付け、本文スクロールを奪わない。
 *
 * 外側divには `useMapOverlayInset()` のコールバックrefを転送する。構造変更や
 * ドラッグ中のCSS translateY は offsetTop/offsetHeight を変えないため、被覆量の
 * 実測(地図の中心合わせ補正)には影響しない。
 */
export function MobileDetailSheet({
	panelRef,
	onDismiss,
	className,
	handleClassName,
	handleLabel = "閉じる",
	children,
}: {
	/** useMapOverlayInset() のコールバックref。外側シートdivに転送する。 */
	panelRef?: (el: HTMLElement | null) => void;
	/** 下スワイプ or ハンドルのタップ/Enterで閉じる。未指定ならハンドルを出さない。 */
	onDismiss?: () => void;
	/** 位置・ブレークポイント制御(lg:hidden / embedのsm:サイドドック等)。 */
	className?: string;
	/** ハンドルの表示制御(embedでsm:hidden等)。 */
	handleClassName?: string;
	handleLabel?: string;
	children: ReactNode;
}) {
	const [dragY, setDragY] = useState(0);
	const [dragging, setDragging] = useState(false);
	const startYRef = useRef(0);
	const activePointerRef = useRef<number | null>(null);
	// release後に発火するclickをタップと誤認しないためのドラッグ判定フラグ。
	const draggedRef = useRef(false);

	const setSheetRef = (el: HTMLDivElement | null) => panelRef?.(el);

	const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (!onDismiss) return;
		if (!e.isPrimary) return; // マルチタッチ(ピンチ)ではドラッグ開始しない
		if (activePointerRef.current !== null) return;
		activePointerRef.current = e.pointerId;
		startYRef.current = e.clientY;
		draggedRef.current = false;
		setDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (activePointerRef.current !== e.pointerId) return;
		const delta = Math.max(0, e.clientY - startYRef.current); // 下方向のみ
		if (delta > DRAG_SLOP_PX) draggedRef.current = true;
		setDragY(delta);
	};

	const finishPointer = (e: ReactPointerEvent<HTMLButtonElement>) => {
		activePointerRef.current = null;
		setDragging(false);
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	};

	const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (activePointerRef.current !== e.pointerId) return;
		const shouldDismiss = dragY > DISMISS_THRESHOLD_PX;
		finishPointer(e);
		setDragY(0); // 常に0へ: 閉じない場合スナップバック、閉じる場合も残留translateYを防ぐ
		if (shouldDismiss) onDismiss?.();
	};

	const onPointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (activePointerRef.current !== e.pointerId) return;
		finishPointer(e);
		setDragY(0);
	};

	// タップ(touch)/クリック(mouse)/Enter・Space(keyboard)での閉じる。
	// ドラッグ直後に発火するclickはdraggedRefで無視する。
	const onClick = () => {
		if (draggedRef.current) {
			draggedRef.current = false;
			return;
		}
		onDismiss?.();
	};

	return (
		<div
			ref={setSheetRef}
			className={cn(
				"flex max-h-[55%] flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur",
				className,
			)}
			style={{
				transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
				transition: dragging ? "none" : "transform 200ms ease-out",
			}}
		>
			{onDismiss && (
				<button
					type="button"
					aria-label={handleLabel}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerCancel}
					onClick={onClick}
					className={cn(
						"flex w-full shrink-0 cursor-grab touch-none select-none items-center justify-center py-2.5 active:cursor-grabbing",
						handleClassName,
					)}
				>
					<span
						aria-hidden
						className="h-1.5 w-10 rounded-full bg-muted-foreground/40"
					/>
				</button>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
		</div>
	);
}
