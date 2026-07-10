import { useCallback, useEffect, useRef } from "react";

/**
 * モバイルで地図に重なる下部詳細パネル(オーバーレイ)が覆う高さ(px)を実測し、
 * `AopMapView` の `getFitInset` に渡すためのフック。
 *
 * 地図の fitBounds は上下左右一律の padding で選択エリアを中心に合わせるが、
 * モバイルではパネルが下半分に重なるため、真の中心に置くとパネルの裏に隠れてしまう。
 * ここで測った被覆量を bottom padding として足すことで、パネルに覆われていない
 * 描画領域を基準に中心へ寄せる。
 *
 * - `panelRef`: オーバーレイ要素に付けるコールバック ref。マウント時に即実測し
 *   (初回 fit のレースを回避)、要素と offsetParent を ResizeObserver で監視する。
 * - `getInset`: 安定した getter。fitBounds 実行時に最新の実測値を読むため、値ではなく
 *   getter として `AopMapView` に渡す。
 *
 * デスクトップではパネルが `lg:hidden`(display:none)となり offsetParent が null・
 * offsetHeight が 0 になるため被覆量は 0 に落ち、副作用なく無効化される。
 */
export function useMapOverlayInset() {
	// 直近の被覆量(px)。再レンダーを避けるため state ではなく ref に保持する
	const bottomRef = useRef(0);
	const observerRef = useRef<ResizeObserver | null>(null);

	// パネル上端から親(地図描画領域)下端までの被覆量を測る
	const measure = useCallback((el: HTMLElement) => {
		const parent = el.offsetParent as HTMLElement | null;
		// display:none のとき offsetParent は null、offsetHeight は 0
		if (!parent || el.offsetHeight === 0) {
			bottomRef.current = 0;
			return;
		}
		bottomRef.current = Math.max(0, parent.clientHeight - el.offsetTop);
	}, []);

	const panelRef = useCallback(
		(el: HTMLElement | null) => {
			observerRef.current?.disconnect();
			observerRef.current = null;
			if (!el) {
				bottomRef.current = 0;
				return;
			}
			measure(el);
			// 前へ/次へでのコンテンツ高変化やビューポート変化に追従する
			const observer = new ResizeObserver(() => measure(el));
			observer.observe(el);
			if (el.offsetParent) observer.observe(el.offsetParent);
			observerRef.current = observer;
		},
		[measure],
	);

	useEffect(() => () => observerRef.current?.disconnect(), []);

	const getInset = useCallback(() => ({ bottom: bottomRef.current }), []);

	return { panelRef, getInset };
}
