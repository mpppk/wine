import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { labelJobMessageSchema } from "#/lib/ai/label-job";
import { logError, logInfo } from "#/lib/logger";
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

const fetch = createStartHandler(defaultStreamHandler);

// `satisfies ExportedHandler<Env>` は**付けない**。Start のハンドラは
// `(request, opts?: RequestOptions)` という独自の第2引数を取り、workerd の
// `(request, env, ctx)` とは型が噛み合わない(既定エントリも型を当てずに引数をそのまま
// 転送している)。ここで型を当てにいくと、実行時に何も変わらないキャストが増えるだけになる。
export default {
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
				await runLabelAnalysisJob(parsed.data.jobId);
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
};
