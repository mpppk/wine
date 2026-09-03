/**
 * @public
 * Start の named environment を使わず `cloudflare:test` の main からアプリ Worker を
 * 読む統合テスト用エントリ。Start のハンドラはモジュール評価時に server-function の
 * ベースパスを環境変数から読むため、実際の `src/worker.ts` を評価する前に注入する。
 */
const processLike = (
	globalThis as typeof globalThis & {
		process: { env: Record<string, string | undefined> };
	}
).process;
processLike.env.TSS_SERVER_FN_BASE = "/_serverFn/";

const appWorker = await import("../src/worker");

export default appWorker.default;
