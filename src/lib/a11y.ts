// a11y のスタイル規約。経路ごとに数値を書くと基準がドリフトするのでここに集約する(#239)。

/**
 * 見た目の大きさを変えずにタップ領域を 44×44px 確保する(WCAG 2.5.5 Target Size)。
 *
 * アイコンボタンを実寸44pxにするとレイアウトが崩れる箇所向け。擬似要素をボタン中央に
 * 重ねて当たり判定だけを広げるため、`position: relative` を伴う。
 *
 * **隣接するボタンに付ける場合は中心間を44px以上離すこと**。近すぎると当たり判定が重なり、
 * 「削除のつもりが編集」のような誤爆が起きて逆効果になる。
 */
export const TAP_TARGET_44 =
	"relative after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";
