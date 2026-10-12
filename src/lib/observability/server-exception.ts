import * as Sentry from "@sentry/cloudflare";
import { type LogFields, logError, logWarn } from "#/lib/logger";

// サーバ側で**握りつぶして 5xx に変えた**想定外例外を Sentry へ送る唯一の入口。
//
// なぜ要るか: `withSentry`(#486、`src/worker.ts`)が拾うのは「ハンドラから throw が
// 抜けた例外」だけ。ところがこのアプリの想定外例外は、ほぼ全部がハンドラの手前で
// catch されて Response に変わる:
//  - server function: `runWithHttpStatus`(middleware.ts)が catch して汎用文言で
//    投げ直し、TanStack Start(`server-functions-handler.js`)がそれを直列化して
//    500 の Response を**返す**。fetch ハンドラからは throw が抜けない
//  - API ルート(`src/routes/api/*`): catch して `apiJsonError(…, 500)` を返す
//  - MCP ツール: catch して `isError: true` の結果を返す
//  - キューのコンシューマ(`src/worker.ts`): 再配信が空振りするため catch して ack する
// どれもクライアントへの露出を抑える・リトライを止めるための正しい catch だが、結果として
// `withSentry` には1件も届かず、`bun run logs --level error` を叩いた人にしか見えなかった。
//
// `alertOperator` との違い: あちらは「運用者が手を動かすと直る、意図して選んだ少数の事象」
// を**運用メッセージを表題に**して送る。こちらは「原因不明の想定外例外」で、**元の例外を
// そのまま**送る——包むとスタックが呼び出し箇所(この関数)になり、全経路の失敗が1つの
// Issue にまとまってしまう。Sentry 側のグルーピングを元の例外のスタックで効かせる。
//
// 想定内の失敗(HttpError 等の 4xx)はここを通さない。呼び出し側が判定してから呼ぶ。

/** 送信に失敗しても呼び出し元へ伝播させないための印(テストから観測する)。 */
const CAPTURE_FAILED = "server exception capture failed";

/** どの入口で握りつぶされたか。Sentry 側で `tags[source]` で絞る。 */
export type ServerExceptionSource = "server_fn" | "api" | "mcp_tool" | "queue";

export interface ServerExceptionOptions {
	source: ServerExceptionSource;
	/** 検索用の短い値(path・tool 名など)。PII を入れないこと。 */
	tags?: Record<string, string | undefined>;
}

/**
 * 想定外の失敗をログに残し、`fields.err` を Sentry へ送る。**この関数は決して throw しない**。
 *
 * ログ行は従来の `logError(msg, fields)` と同一(既存の `bun run logs --grep` が
 * そのまま効く)。Sentry へは `err` だけを送り、`fields` の他の値は送らない——
 * userId などはログ(保持7日・APIトークン必須)に留め、Sentry 側はログと
 * `msg` / 時刻で突き合わせる。
 */
export function reportServerException(
	msg: string,
	fields: LogFields,
	options: ServerExceptionOptions,
): void {
	logError(msg, fields);
	try {
		const tags: Record<string, string> = {
			runtime: "workers",
			source: options.source,
		};
		for (const [k, v] of Object.entries(options.tags ?? {})) {
			if (v !== undefined) tags[k] = v;
		}
		Sentry.captureException(fields.err, {
			level: "error",
			tags,
			// 何の処理で失敗したかは例外自体には無いので、ログと同じ msg を添える。
			extra: { msg },
		});
	} catch (e) {
		// 収集基盤の失敗で元の処理(既にエラー応答を組み立て中)を巻き込まない。
		logWarn(CAPTURE_FAILED, { err: e });
	}
}
