import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";
import { cn } from "#/lib/utils";

// 下スワイプ量がこれを超えて離すと閉じる。超えなければ元位置へ戻す。
const DISMISS_THRESHOLD_PX = 100;
// 上スワイプでこれを超えると拡大、拡大状態で下スワイプがこれを超えると通常へ戻す。
const EXPAND_THRESHOLD_PX = 60;
// これ以上動いたら「タップ」ではなく「ドラッグ」とみなし、release後のclickを無視する。
const DRAG_SLOP_PX = 6;
// 拡大時の高さ。シートは absolute でマップコンテナ内に配置され、通常時の
// max-h-[55%] もコンテナ基準のため、拡大も同じコンテナ基準の割合(90%)にする。
// dvh(ビューポート基準)にするとコンテナ上端(上部ツールバー)を超えてハンドルが
// ツールバー背後に隠れ、下スワイプで縮小できなくなる。EXPANDED_RATIO と一致させる。
const EXPANDED_MAX_HEIGHT = "90%";
const EXPANDED_RATIO = 0.9;
// ライブ拡大/縮小時に潰れないための最小高さ(px)。
const MIN_LIVE_HEIGHT_PX = 80;

const clamp = (v: number, min: number, max: number) =>
	Math.min(Math.max(v, min), max);

/**
 * モバイルの下部詳細パネル(ボトムシート)ラッパー。最上部中央のハンドルを持って
 * 上下にスワイプするとサイズを切り替えられる:
 *   - 通常サイズで下スワイプ → 閉じる(Notion等と同じ挙動)
 *   - 通常サイズで上スワイプ → 拡大(ほぼ全画面)
 *   - 拡大状態で下スワイプ → 通常サイズへ戻る
 * 非タッチ環境向けにハンドルのタップ/クリック/キーボード(Enter/Space)でも閉じられる。
 *
 * 構造は「固定ハンドル + スクロールする本文」。外側divは overflow-hidden とし、
 * children は内側の overflow-y-auto に入れることでスクロールしてもハンドルは
 * 上部に固定される。ドラッグはハンドル上でのみ受け付け、本文スクロールを奪わない。
 *
 * 外側divには `useMapOverlayInset()` のコールバックrefを転送する。閉じる方向の
 * ドラッグ(translateY)は offsetHeight を変えないため被覆量に影響しないが、拡大/
 * 縮小(maxHeight)は offsetHeight を変えるので ResizeObserver が被覆量を再計測する
 * (fitBounds は選択変更時のみ走るため、ドラッグ追従で地図が跳ねることはない)。
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
	// 下方向を正とする符号付きドラッグ量(上スワイプは負)。
	const [dragY, setDragY] = useState(0);
	const [dragging, setDragging] = useState(false);
	// 拡大表示中かどうか(通常 ⇄ 拡大)。
	const [expanded, setExpanded] = useState(false);
	// 閉じるアニメーション中かどうか。true の間は下方向へスライドさせ、
	// transition 完了(またはフォールバックタイマー)で onDismiss を呼ぶ。
	const [closing, setClosing] = useState(false);
	// 二重発火防止・stale closure 回避用。closing state と同期させる。
	const closingRef = useRef(false);
	const startYRef = useRef(0);
	const activePointerRef = useRef<number | null>(null);
	// release後に発火するclickをタップと誤認しないためのドラッグ判定フラグ。
	const draggedRef = useRef(false);
	// 外側シートdivの参照(ドラッグ開始時の実高さ・親高さの実測に使う)。
	const sheetElRef = useRef<HTMLDivElement | null>(null);
	// ドラッグ開始時の実高さと拡大上限(px)。ライブ追従の基準にする。
	const startHeightRef = useRef(0);
	const maxLiveHeightRef = useRef(0);

	const setSheetRef = (el: HTMLDivElement | null) => {
		sheetElRef.current = el;
		panelRef?.(el);
	};

	// 閉じるアニメーションを開始する。下方向へスライドさせ、transition 完了で
	// onDismiss を呼ぶ(下記 onTransitionEnd)。transitionend が発火しない環境向けに
	// フォールバックタイマーも張る。二重発火は closingRef で防ぐ。
	const beginClose = () => {
		if (closingRef.current) return;
		closingRef.current = true;
		setClosing(true);
		setDragging(false);
		setTimeout(() => {
			if (!closingRef.current) return;
			closingRef.current = false;
			onDismiss?.();
		}, 260);
	};

	const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (!onDismiss) return;
		if (closingRef.current) return; // 閉じるスライド中は再ドラッグを受け付けない
		if (!e.isPrimary) return; // マルチタッチ(ピンチ)ではドラッグ開始しない
		if (activePointerRef.current !== null) return;
		activePointerRef.current = e.pointerId;
		startYRef.current = e.clientY;
		draggedRef.current = false;
		// ライブ追従の基準となる現在の実高さと拡大上限を記録する。
		const el = sheetElRef.current;
		startHeightRef.current = el?.offsetHeight ?? 0;
		const parentHeight =
			(el?.offsetParent as HTMLElement | null)?.clientHeight ?? 0;
		maxLiveHeightRef.current = parentHeight * EXPANDED_RATIO;
		setDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (activePointerRef.current !== e.pointerId) return;
		const delta = e.clientY - startYRef.current; // 下方向を正、上方向を負
		if (Math.abs(delta) > DRAG_SLOP_PX) draggedRef.current = true;
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
		const delta = dragY;
		finishPointer(e);
		if (expanded) {
			setDragY(0); // スナップバック時も残留translateY/高さを防ぐ
			// 拡大状態: 十分に下スワイプしたら通常サイズへ戻す。
			if (delta > EXPAND_THRESHOLD_PX) setExpanded(false);
		} else if (delta > DISMISS_THRESHOLD_PX) {
			// 通常状態 + 下スワイプで閉じる: dragY は 0 に戻さず、そのまま
			// 下方向へスライドさせて画面外へ消す(上へ戻さない)。
			beginClose();
		} else {
			setDragY(0); // スナップバック
			// 上スワイプで拡大。
			if (delta < -EXPAND_THRESHOLD_PX) setExpanded(true);
		}
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
		// スワイプ閉じと同じく下方向へスライドさせてから閉じる。
		beginClose();
	};

	// 高さ・変形のライブ算出。閉じる方向のみ translateY でスライドさせ、
	// 拡大/縮小は maxHeight を上下端固定(bottom基準)で伸縮させて指に追従する。
	// maxHeight を使うことで内容が短いときは縮む既存挙動を保つ。
	let transform: string | undefined;
	let maxHeight: string | undefined = expanded
		? EXPANDED_MAX_HEIGHT
		: undefined;
	if (closing) {
		// 閉じるスライド: シート全体を画面下部へ逃がす。100%(=シート自身の高さ)
		// だけではシート下端〜画面下端の余白(bottom-2 + 下部バー等)が残り、
		// ハンドルが下部に少し覗くため、余白を上乗せして確実に画面外へ出す。
		// 指を離した位置から下へ滑って消える。
		transform = "translateY(calc(100% + 96px))";
	} else if (dragging) {
		if (!expanded) {
			if (dragY > 0) {
				// 通常 + 下ドラッグ: 閉じるプレビュー(スライド)。
				transform = `translateY(${dragY}px)`;
			} else if (dragY < 0) {
				// 通常 + 上ドラッグ: 拡大プレビュー(上へ伸びる)。
				maxHeight = `${clamp(
					startHeightRef.current - dragY,
					MIN_LIVE_HEIGHT_PX,
					maxLiveHeightRef.current || startHeightRef.current - dragY,
				)}px`;
			}
		} else if (dragY > 0) {
			// 拡大 + 下ドラッグ: 縮小プレビュー(上端が下がる)。
			maxHeight = `${clamp(
				startHeightRef.current - dragY,
				MIN_LIVE_HEIGHT_PX,
				startHeightRef.current,
			)}px`;
		}
	}

	return (
		<div
			ref={setSheetRef}
			className={cn(
				"flex max-h-[55%] flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur",
				className,
			)}
			style={{
				transform,
				maxHeight,
				transition: dragging
					? "none"
					: "transform 200ms ease-out, max-height 200ms ease-out",
			}}
			onTransitionEnd={(e) => {
				// 閉じるスライドの完了で初めてアンマウントさせる。子要素から
				// バブリングした transition は無視する(外側divのtransformのみ)。
				if (e.target !== e.currentTarget) return;
				if (e.propertyName !== "transform") return;
				if (!closingRef.current) return;
				closingRef.current = false;
				onDismiss?.();
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
