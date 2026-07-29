// 地図に重ねる凡例(AOP地図の進捗モード / マイセラー地図の所有状態)の折りたたみ状態。
// 色の意味は一度理解すれば読み返さない情報である一方、凡例は地図のラベルに重なる。
// そこで「閉じた」状態を端末側に覚えさせ、次回以降は最初から小さなチップだけを出す。
//
// 学習データではなく端末側の表示設定なので、D1 ではなく localStorage に置く
// (端末をまたぐと再表示される)。src/lib/dashboard/guide-dismissal.ts と同じ方針。
// ただしガイドと違い SSR 時に描画されない地図オーバーレイなので、ペイント前の
// ブートストラップスクリプトは不要(マウント後に読んで確定させれば十分)。

/** 凡例ごとの localStorage キー。凡例を足したらここに1行足す(キーの重複を防ぐ) */
export const MAP_LEGEND_KEYS = {
	/** AOP地図の進捗モード(クイズ正解率) */
	progress: "map-progress-legend-collapsed",
	/** マイセラー地図の所有状態 */
	cellarStatus: "cellar-status-legend-collapsed",
} as const;

export type MapLegendKey =
	(typeof MAP_LEGEND_KEYS)[keyof typeof MAP_LEGEND_KEYS];

/** 折りたたみ済みか。localStorage が使えない環境(プライベートモード等)では展開扱い */
export function isMapLegendCollapsed(key: MapLegendKey): boolean {
	try {
		return window.localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

/** 折りたたみ状態を永続化する。失敗してもそのセッションの表示は変わるので黙って無視 */
export function setMapLegendCollapsed(
	key: MapLegendKey,
	collapsed: boolean,
): void {
	try {
		if (collapsed) {
			window.localStorage.setItem(key, "1");
		} else {
			window.localStorage.removeItem(key);
		}
	} catch {
		// localStorage が使えなくても、このセッションで開閉できていれば十分
	}
}
