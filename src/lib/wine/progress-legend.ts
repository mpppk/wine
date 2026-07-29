// 地図の進捗モードで左下に出す凡例(クイズ正解率のカラースケール)の折りたたみ状態。
// 色の意味は一度理解すれば読み返さない情報である一方、凡例は地図のラベルに重なる。
// そこで「閉じた」状態を端末側に覚えさせ、次回以降は最初からアイコンだけを出す。
//
// 学習データではなく端末側の表示設定なので、D1 ではなく localStorage に置く
// (端末をまたぐと再表示される)。src/lib/dashboard/guide-dismissal.ts と同じ方針。
// ただしガイドと違い SSR 時に描画されない地図オーバーレイなので、ペイント前の
// ブートストラップスクリプトは不要(マウント後に読んで確定させれば十分)。

export const PROGRESS_LEGEND_COLLAPSED_KEY = "map-progress-legend-collapsed";

/** 折りたたみ済みか。localStorage が使えない環境(プライベートモード等)では展開扱い */
export function isProgressLegendCollapsed(): boolean {
	try {
		return window.localStorage.getItem(PROGRESS_LEGEND_COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** 折りたたみ状態を永続化する。失敗してもそのセッションの表示は変わるので黙って無視 */
export function setProgressLegendCollapsed(collapsed: boolean): void {
	try {
		if (collapsed) {
			window.localStorage.setItem(PROGRESS_LEGEND_COLLAPSED_KEY, "1");
		} else {
			window.localStorage.removeItem(PROGRESS_LEGEND_COLLAPSED_KEY);
		}
	} catch {
		// localStorage が使えなくても、このセッションで開閉できていれば十分
	}
}
