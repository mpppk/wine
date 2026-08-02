import {
	captureException,
	init,
	makeBrowserOfflineTransport,
	makeFetchTransport,
} from "@sentry/react";
import type { ErrorReporter } from "./client-error";

// Sentry の設定と初期化。**このファイルだけが `@sentry/react` を import する**
// (Issue #381)。client-error.ts から動的 import され、DSN が設定された環境でのみ
// 読み込まれる。
//
// `import * as Sentry from "@sentry/react"` にしないこと。名前空間として取り込むと
// Rollup が「どのエクスポートが使われるか」を証明できず、**tree-shaking が丸ごと
// 効かなくなる**(Session Replay/rrweb 込みで 154KB gz が常に付いてくる)。
// 名前付き import にすれば使う分だけが残る。

/** 送信先を解決する環境名。ドメインから導出するので、プレビューごとにビルド変数を
 * 設定しなくても本番のイベントと混ざらない。 */
function resolveEnvironment(): string {
	const host = window.location.hostname;
	if (host === "wine.nibo.sh") return "production";
	if (host === "localhost" || host === "127.0.0.1") return "local";
	return "preview";
}

/** Sentry を初期化し、収集の口を返す。 */
export function setupSentry(dsn: string): ErrorReporter {
	init({
		dsn,
		environment: resolveEnvironment(),
		// Workers Builds のコミットSHAを入れるとソースマップと紐づく(未設定でも動く)
		release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
		// IPアドレス・Cookie等を自動で付けない。ワイン写真・メールを扱うアプリなので
		// 既定を明示的に閉じる
		sendDefaultPii: false,
		// **この設定が本命**。通信が死んでいる状態で起きたエラーを IndexedDB に貯め、
		// オンライン復帰後に送る。#379 の失敗モード(レスポンスが返らない)では、
		// これが無いとエラー報告そのものも届かない
		transport: makeBrowserOfflineTransport(makeFetchTransport),
		// トレース(パフォーマンス計測)と Session Replay は入れない。欲しいのは失敗の
		// 可視化で、どちらも無料枠を最も速く食う。特に Replay は rrweb を伴い、
		// 転送量が 3.5 倍(44KB gz → 154KB gz)になる。**電波の悪い場所で使うアプリで、
		// 転送量の増加が一番効くのは不具合を踏むユーザ自身**なので既定では入れない
	});
	return { captureException };
}
