// ブラウザ側で起きたエラーを収集する**唯一の入口**(Issue #381)。
//
// なぜ要るか: #379 の「写真を解析する」が `Failed to fetch` になる不具合は、本番の
// Workers Logs にリクエストが1件も残らなかった。fetch がレスポンスを受け取る前に
// 失敗するとサーバ側は何も観測できず、`bun run logs` では原因に到達できない。
// クライアントで起きたことはクライアントから送るしかない。
//
// なぜ1箇所に寄せるか: 経路ごとに `Sentry.captureException` を直書きすると、後から
// 足した経路で必ず漏れる(構造化ログが新ドメイン群で未適用になった #166、MIME検証が
// ワイン写真経路に未適用だった #174 と同じ再演)。**送る先を差し替えても、送る判断を
// する場所は増やさない**。
//
// 実際、Sentry 導入(#382)以前からあった握りつぶし(クイズの解答保存・AOP地図の
// 読み込み失敗)は `console.error` のまま取り残されており、#184 型の回帰が起きても
// イベント0件で気付けない状態だった(#390)。同じドリフトを繰り返さないよう、
// **クライアントのUIコード(`src/components/**` / `src/routes/**`)では
// `console.*` を biome の `suspicious/noConsole` で禁止**してある(biome.json の
// overrides)。握りつぶすときはここを通す——コンソール出力もこの関数がやる。
//
// 送信先(Sentry)は動的 import する。理由は3つ:
//  - DSN 未設定(ローカル・CI・DSNを入れない環境)では**1バイトも読み込まない**
//  - 初期表示のクリティカルパスに約30KB(gz)のSDKを載せない
//  - `@sentry/react` はブラウザ専用。SSR(workerd)ビルドに混ざると Worker が壊れる
//    (`@sentry/tanstackstart-react` が同じ理由で Workers 非対応: getsentry/sentry-javascript#20038)

/** 収集先に求める最小の口。テストではこれを差し替える(Sentry を読み込まない)。 */
export interface ErrorReporter {
	captureException(
		error: unknown,
		hint?: { extra?: Record<string, unknown> },
	): void;
}

/** 送信時に一緒に送る補助情報。**PIIを入れない**(件数・バイト数・パス等に限る)。 */
export type ErrorContext = Record<string, unknown>;

let reporter: ErrorReporter | null = null;

/** DSN はビルド時に埋め込む公開値(Sentry の DSN は秘密情報ではない)。 */
function dsn(): string {
	return import.meta.env.VITE_SENTRY_DSN?.trim() ?? "";
}

async function loadSentry(): Promise<ErrorReporter> {
	// 設定は sentry-client.ts 側に置く(`@sentry/react` を import するのはあちらだけ)
	const { setupSentry } = await import("./sentry-client");
	return setupSentry(dsn());
}

/**
 * 収集を開始する。**クライアントでのみ呼ぶこと**(SSR では import ごと落とす)。
 * DSN 未設定なら何も読み込まず、以後 `reportClientError` はコンソール出力だけになる。
 *
 * `load` を差し替えられるのはテストのため(実SDKを読み込まずに配線を検証する)。
 */
export async function initClientErrorReporting(
	load: () => Promise<ErrorReporter | null> = loadSentry,
): Promise<void> {
	if (!dsn()) {
		reporter = null;
		return;
	}
	try {
		reporter = await load();
	} catch (e) {
		// 収集基盤の失敗でアプリを壊さない。ここで throw すると unhandledrejection に化ける
		console.error("failed to initialize client error reporting", e);
		reporter = null;
	}
}

/**
 * 握りつぶしたエラーを収集先へ送る。**送信の成否にかかわらずコンソールにも必ず出す**
 * (DevTools での切り分けは DSN の有無に依存させない)。この関数は決して throw しない。
 *
 * 初期化が終わる前に呼ばれたぶんは送られない。実害があるのは「ハイドレーション直後の
 * 数百ms以内に起きたエラー」だけで、収集したいのは操作起点の失敗なので許容する。
 */
export function reportClientError(
	error: unknown,
	context: ErrorContext = {},
): void {
	try {
		console.error("client error", context, error);
		reporter?.captureException(error, { extra: context });
	} catch {
		// 収集の失敗を呼び出し元へ伝播させない(呼び出し元は既にエラー処理中)
	}
}
