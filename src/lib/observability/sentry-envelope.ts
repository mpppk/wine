// サーバ側の環境名解決の SSOT。
//
// `src/worker.ts` の `withSentry` 初期化・Langfuse の計装(`langfuse.ts` /
// `langfuse-prompt.ts`)が共有する。**対応を足すときはここだけを変える**——
// 片方だけ足すと同じ障害が2つの environment に割れて見える。
//
// #649 で `operator-alert` の送信は SDK(`captureMessage` / `captureException`)へ
// 移し、envelope の手組み(`parseSentryDsn` / `buildSentryEnvelope`)は削除した。
// DSN の解決・environment の付与・PII の抑止・送信の再試行は `withSentry` の
// 初期化に委ねるため、2系統の保守が要らなくなった。`alertOperator` は
// environment を手で付けない(初期化済みの値を使う)。

/**
 * 送信先ホスト名から環境名を導出する。クライアント側(sentry-client.ts の
 * `resolveEnvironment`)と同じ対応にする——**片方だけ足すと同じ障害が2つの
 * environment に割れて見える**。
 */
export function resolveServerEnvironment(baseUrl: string | undefined): string {
	if (!baseUrl) return "local";
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return "local";
	}
	if (host === "wine.nibo.sh") return "production";
	if (host === "localhost" || host === "127.0.0.1") return "local";
	return "preview";
}
