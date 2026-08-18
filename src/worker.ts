import * as Sentry from "@sentry/cloudflare";
import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { labelJobMessageSchema } from "#/lib/ai/label-job";
import { logError, logInfo } from "#/lib/logger";
import { resolveServerEnvironment } from "#/lib/observability/sentry-envelope";
import { withSpan } from "#/lib/observability/span";
import { runLabelAnalysisJob } from "#/lib/services/label-job-service";

// Worker のエントリ(Issue #460)。
//
// **なぜ自前のエントリを持つのか**: エチケット解析をジョブ化するには `fetch` と並んで
// キュー・コンシューマ(`queue`)を export する必要があるが、既定の
// `@tanstack/react-start/server-entry` は `fetch` しか持たない。実体は数行しかないので
// (`createStartHandler(defaultStreamHandler)` を `{ fetch }` に包むだけ)、同じ内容を
// ここに写して `queue` を併設する。
//
// **別ワーカーを立てる必要は無い**。この形で
//  - `bun run build` が通り、バンドルに `queue` が含まれる
//  - `queues` の producer/consumer 設定が、プラグインが生成する
//    `dist/server/wrangler.json` に伝播する
//  - `bun run check:deploy` に `env.LABEL_JOBS (wine-label-jobs) Queue` が出る
// ことを確認済みで、#103(プラグインが生成する設定と CLI の食い違い)の類型も踏まない。

const startFetch = createStartHandler(defaultStreamHandler);

// Start のハンドラは `(request, opts?)` という独自シグネチャ(上記 #460 コメント)で、
// workerd の `(request, env, ctx)` と型が噛み合わない。`withSentry`(後述)がハンドラに
// `ExportedHandler` の型を要求するため、ここで一度だけ workerd のシグネチャに合わせる。
// 実行時の挙動は変わらない(env / ctx は使われない)。
const fetch: ExportedHandlerFetchHandler<Cloudflare.Env> = (request) =>
	startFetch(request);

// サーバ側の予期しない例外を Sentry に自動送信する(Issue #486)。
// `withSentry` は fetch / scheduled / queue / email / tail を自動計装し、ハンドラが
// throw した例外をキャプチャする。`operator-alert`(#395)の「意図して選んだ少数の
// 事象」を**置き換えず**、その手が届かない「予期しない例外」を拾う役割。
export default Sentry.withSentry(
	(env) => ({
		// #395 で投入済みのシークレットをそのまま使う。ハードコードしない。
		dsn: env.SENTRY_DSN,
		// クライアント側(sentry-client.ts)と同じ環境名の導出を使う。片方だけ
		// 足すと同じ障害が2つの environment に割れて見える(sentry-envelope.ts 参照)。
		environment: resolveServerEnvironment(env.BETTER_AUTH_URL),
		// トレースは入れない(無料枠を最も速く食う)。`tracesSampleRate` を指定しない
		// のが「オフ」の意味で、0 を渡すとトランザクションを全捨てする設定になる。
		//
		// `dataCollection` オブジェクトを渡すと**未指定カテゴリは寛容な既定値**
		// (userInfo: true / cookies: true / httpBodies: 全種類)に切り替わる
		// (docs.sentry.io の Options 参照)。`{ userInfo: false }` だけでは逆に
		// クッキーやボディが送られるようになるため、クライアント側の
		// `sendDefaultPii: false`(sentry-client.ts)と同じ水準まで全カテゴリを
		// 明示的に閉じる。ワイン写真・メールを扱うアプリなので PII を自動収集しない。
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			httpBodies: [],
			urlQueryParams: false,
			genAI: { inputs: false, outputs: false },
			graphQL: { document: false, variables: false },
			databaseQueryData: false,
			stackFrameVariables: false,
		},
	}),
	{
		fetch,

		/**
		 * エチケット解析ジョブのコンシューマ。
		 *
		 * **1メッセージずつ順に処理する**。並行に回すと、同一ユーザの連投が同時に推論へ入って
		 * 原価が跳ねる(同時実行の上限は投入側で見ているが、それは「予約の同時数」であって
		 * 「推論の同時数」ではない)。ジョブは実測30秒前後で、バッチは既定で最大10件・
		 * `max_batch_timeout` も短いので、直列でも滞留しない。
		 *
		 * **例外を投げない**。`runLabelAnalysisJob` は失敗をジョブ行に書いて正常復帰する設計で、
		 * ここで再 throw するとキューが再配信するが、claim ガード(`queued` の間だけ掴む)に
		 * より再配信は必ず空振りする。つまりリトライしても直らないので ack する。
		 * メッセージの形が想定外(古いデプロイが積んだ形など)の場合も同じく捨てる。
		 */
		async queue(batch: MessageBatch<unknown>): Promise<void> {
			for (const message of batch.messages) {
				const parsed = labelJobMessageSchema.safeParse(message.body);
				if (!parsed.success) {
					logError("unexpected label job message; discarding", {
						messageId: message.id,
						err: parsed.error,
					});
					message.ack();
					continue;
				}
				try {
					// **1メッセージ = 1スパン**にする(#504)。自動計装の queue ハンドラスパンは
					// バッチ全体(最大5件)で1つなので、それだけでは「どのジョブが遅かったか」
					// 「何件目で落ちたか」が出ない。直列に回している以上、ここが分からないと
					// バッチ全体の所要時間から個々の推論を推測することになる。
					await withSpan(
						"label_job",
						{
							"wine.job.id": parsed.data.jobId,
							"wine.queue.message_id": message.id,
							"wine.queue.attempt": message.attempts,
						},
						() => runLabelAnalysisJob(parsed.data.jobId),
					);
				} catch (e) {
					// runLabelAnalysisJob は失敗を行に書いて返る想定なので、ここに来るのは
					// D1 障害などジョブ行にすら書けなかった場合。再配信は claim ガードで
					// 空振りするため ack し、未終端のまま残った行は stale が決着させる。
					logError("label job consumer failed", {
						jobId: parsed.data.jobId,
						err: e,
					});
				}
				message.ack();
			}
			logInfo("label job batch processed", { size: batch.messages.length });
		},
	},
);
