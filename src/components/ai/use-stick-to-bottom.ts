import { useCallback, useEffect, useRef } from "react";

/**
 * 「最下部付近を見ている」とみなす余白(px)。行の高さ程度を許容し、端数スクロールや
 * 小数のズレで追従が外れないようにする。
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

/** スクロール位置が最下部付近か(追従を続けてよいか)。 */
export function isNearBottom(
	el: { scrollTop: number; scrollHeight: number; clientHeight: number },
	threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * 末尾に追記されていくログを「最下部に貼り付ける」ためのフック(#242)。
 *
 * `contentSignal` が変わるたびに最下部へスクロールする。ただし **ユーザが自分で上に
 * スクロールしている間は追従しない**。過去の回答を読んでいる最中に新着で引き戻されるのは、
 * 追従が無いのと同じくらい操作の邪魔になるため。判定は「直前のスクロール位置が最下部付近か」で、
 * 追記でコンテナが伸びる前の状態を onScroll 時点で覚えておく必要がある(追記後に測ると
 * 伸びたぶんだけ必ず「離れている」と判定されてしまう)。
 */
export function useStickToBottom<T extends HTMLElement>(
	contentSignal: unknown,
): {
	ref: React.RefObject<T | null>;
	onScroll: () => void;
} {
	const ref = useRef<T>(null);
	// 初期状態は最下部(空のログは最下部と最上部が同じ)
	const stick = useRef(true);

	const onScroll = useCallback(() => {
		const el = ref.current;
		if (el) stick.current = isNearBottom(el);
	}, []);

	// contentSignal は「内容が変わった」ことを伝えるためだけの依存で、効果の本体では
	// 参照しない(参照するのは ref 経由の実DOM)。値自体に意味は無く、変化が追従の契機になる。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 上記のとおり変化の検知にのみ使う
	useEffect(() => {
		const el = ref.current;
		if (!el || !stick.current) return;
		el.scrollTop = el.scrollHeight;
	}, [contentSignal]);

	return { ref, onScroll };
}
