import { useEffect } from "react";

/**
 * 詳細パネル表示中、←/→ キーで前後の同一区分AOPへ移動できるようにするフック。
 *
 * リスナは capture フェーズ + preventDefault で登録し、MapLibre のキーボード操作
 * (矢印キーによる地図パン)を map canvas より先に握りつぶす。パネルはメインルートで
 * デスクトップ/モバイルの2箇所に同時マウントされるため、二重発火を避けるべく
 * このフックは親ルートで1回だけ呼ぶこと。
 */
export function useAopKeyNav({
	onPrev,
	onNext,
	enabled,
}: {
	onPrev?: () => void;
	onNext?: () => void;
	enabled: boolean;
}) {
	useEffect(() => {
		if (!enabled) return;
		const handler = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			// 修飾キー併用(ブラウザの戻る等)には介入しない
			if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
			// 入力欄にフォーカス中はキャレット移動を優先する
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable)
			) {
				return;
			}
			if (e.key === "ArrowLeft" && onPrev) {
				e.preventDefault();
				onPrev();
			} else if (e.key === "ArrowRight" && onNext) {
				e.preventDefault();
				onNext();
			}
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [enabled, onPrev, onNext]);
}
