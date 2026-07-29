import type { ReactNode } from "react";

// 動的に現れる文言を支援技術へ通知するための常設コンテナ(#239)。
//
// スクリーンリーダーは「既にDOMにあるライブリージョンの中身が変わったとき」に読み上げる。
// `{error && <p role="alert">…</p>}` のように条件描画でリージョンごと出し入れすると、
// 挿入と同時に読み上げ対象になるかは実装依存で、特に role="status"(polite)は無視されやすい。
// そのため **中身が空でもコンテナは常に描画する** のがこのコンポーネントの要点で、
// 呼び出し側は `{cond && …}` をコンテナの外ではなく children 側に置く。
//
// 正誤フィードバック・送信エラー・処理中表示のような「画面が動いたことを目で見て分かる」
// 表示は、経路ごとに書くと後発の経路で必ず漏れる(CLAUDE.md)。ここを共通の関門にする。

export function LiveRegion({
	tone = "status",
	className,
	children,
}: {
	/**
	 * `status`: 補足的な状態変化。読み上げ中の内容を中断しない(polite)。
	 * `alert`: 対処が要る失敗。即座に割り込んで読み上げる(assertive)。
	 */
	tone?: "status" | "alert";
	className?: string;
	children?: ReactNode;
}) {
	const isAlert = tone === "alert";
	return (
		<div
			// role が既定の aria-live を含意するが、古い支援技術向けに明示も併記する
			role={isAlert ? "alert" : "status"}
			aria-live={isAlert ? "assertive" : "polite"}
			className={className}
		>
			{children}
		</div>
	);
}
