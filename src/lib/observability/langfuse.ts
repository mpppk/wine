import { env, waitUntil } from "cloudflare:workers";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
	createTraceId,
	setLangfuseTracerProvider,
	startObservation,
} from "@langfuse/tracing";
import { TraceFlags } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { langfuseMask } from "./langfuse-mask";
import { resolveServerEnvironment } from "./sentry-envelope";

// Langfuse へ出す唯一の入口(#512)。
//
// `tracing.enterSpan` を経路ごとに直書きしないのと同じ理由で、`startObservation` を
// `ai-service.ts` に直書きしない。`src/lib/services/metered-inference.ts` の
// `finishMeteredInference`（全AI経路が必ず通るチョークポイント）で trace を張り、
// 推論本体は `ctx.recordGeneration()` で報告するだけにする。
//
// - キー未設定なら丸ごと no-op（例外を投げない）
// - `exportMode: "immediate"` + `waitUntil(forceFlush())` で応答経路から外す
// - `mediaUploadEnabled: false` を明示（写真がメディアストレージへ上がる経路を塞ぐ）
// - `mask` フックが唯一の関門（data URI / base64 / 認証情報を機械的に落とす）

// Cloudflare Workers の isolate 内で1回だけ初期化する。
let provider: BasicTracerProvider | null = null;
let processor: LangfuseSpanProcessor | null = null;

function langfuseKeys(): { publicKey: string; secretKey: string } | null {
	const e = env as unknown as Record<string, string | undefined>;
	// ローカル開発では `process.env`（.env）や `globalThis` からも読めるようにする。
	// workerd 本番/プレビューでは `env`（wrangler secret / .dev.vars）が正だが、
	// テストや一部ツールでは process.env に載ることがあるためフォールバックする。
	const g = globalThis as unknown as Record<string, string | undefined>;
	const p =
		typeof process !== "undefined"
			? (process as unknown as { env?: Record<string, string | undefined> }).env
			: undefined;
	const publicKey = (
		e.LANGFUSE_PUBLIC_KEY ??
		p?.LANGFUSE_PUBLIC_KEY ??
		g.LANGFUSE_PUBLIC_KEY ??
		""
	).trim();
	const secretKey = (
		e.LANGFUSE_SECRET_KEY ??
		p?.LANGFUSE_SECRET_KEY ??
		g.LANGFUSE_SECRET_KEY ??
		""
	).trim();
	if (!publicKey || !secretKey) return null;
	return { publicKey, secretKey };
}

function ensureProvider(): BasicTracerProvider | null {
	const keys = langfuseKeys();
	if (!keys) return null;
	if (provider) return provider;
	const langfuseProcessor = new LangfuseSpanProcessor({
		publicKey: keys.publicKey,
		secretKey: keys.secretKey,
		baseUrl: "https://jp.cloud.langfuse.com",
		environment: resolveServerEnvironment(
			(env as unknown as { BETTER_AUTH_URL?: string }).BETTER_AUTH_URL,
		),
		exportMode: "immediate",
		mediaUploadEnabled: false,
		mask: langfuseMask,
	});
	provider = new BasicTracerProvider({
		spanProcessors: [langfuseProcessor],
	});
	processor = langfuseProcessor;
	// **グローバルには登録しない**。Langfuse 側の隔離スロットに差す。
	// `trace.setGlobalTracerProvider` は「プロセスで1回だけ」であり、vite dev では
	// 依存解決の分岐で `@opentelemetry/api` が2コピーになり、片方が登録した
	// グローバルを他方の `getTracerProvider()` が見えない(バージョン不一致で
	// duplicate registration エラーになり、span が no-op tracer へ流れて黙って消える)。
	// `setLangfuseTracerProvider` は Langfuse 自身の Symbol スロット経由で
	// provider を直接差すため、API のコピー数に依存しない。
	setLangfuseTracerProvider(provider);
	return provider;
}

function flushLangfuse(): void {
	if (!processor) return;
	const p = processor.forceFlush().catch(() => {});
	try {
		waitUntil(p);
	} catch {
		// リクエスト文脈の外(テスト等)。fetch は走っているので素通しする。
	}
}

/** `ctx.recordGeneration()` に渡す1回ぶんのモデル呼び出し。 */
export interface LangfuseGenerationInput {
	name: string;
	model: string;
	input: unknown;
	output?: unknown;
	/**
	 * 写真インベントリなどの構造的な付帯情報。**入力テキストとは別の属性になる**ため、
	 * 入力が長くて mask に切り詰められてもここは生きる(#514)。
	 */
	metadata?: Record<string, unknown>;
	/** トークン内訳。Workers AI のように内訳が無い場合は total のみにしてよい。 */
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}

/** `ctx.recordSpan()` に渡す1回ぶんのツール実行・web検索(#514)。 */
export interface LangfuseSpanInput {
	name: string;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	/** 失敗したツール呼び出しは ERROR にして、トレース上で失敗が見えるようにする。 */
	level?: "DEFAULT" | "WARNING" | "ERROR";
	statusMessage?: string;
}

export interface LangfuseTraceHandle {
	readonly traceId: string;
	recordGeneration(input: LangfuseGenerationInput): void;
	/**
	 * ツール実行・web検索1回ぶんを span として報告する(#514)。
	 * generation と同じく root の直下に並べる(実行順が時刻で読めるので十分)。
	 */
	recordSpan(input: LangfuseSpanInput): void;
	/**
	 * trace の結末を書いて閉じる。`outcome` は実行記録と同じ値。
	 * `output` は trace 全体の出力（成功時は回答、失敗時は未設定）。
	 */
	end(options: {
		outcome: "ok" | "failed";
		output?: unknown;
		errorMessage?: string;
	}): void;
}

/**
 * AI推論1回ぶんの trace（root observation）を開始する。
 * キー未設定なら null（no-op）。例外は投げない。
 *
 * traceId は `createTraceId(requestId)` で決定的に導出する（ログの requestId・
 * クレジット台帳の request_id・Langfuse のトレースURLが同じキーで直結する）。
 */
export async function startLangfuseTrace(options: {
	name: string;
	requestId: string;
	feature: string;
	input?: unknown;
	metadata?: Record<string, unknown>;
}): Promise<LangfuseTraceHandle | null> {
	try {
		if (!ensureProvider()) return null;
		const traceId = await createTraceId(options.requestId);
		// 決定的 traceId を root span に持たせるため、ダミーの親 SpanContext を渡す。
		// traceId は32 hex、spanId は16 hex（all-zero は無効なので 000...001 を使う）。
		const parentSpanContext = {
			traceId,
			spanId: "0000000000000001",
			traceFlags: TraceFlags.SAMPLED,
			isRemote: true,
		} as const;
		const root = startObservation(
			options.name,
			{
				input: options.input,
				metadata: {
					feature: options.feature,
					requestId: options.requestId,
					...options.metadata,
				},
			},
			{ parentSpanContext },
		);
		return {
			traceId,
			recordGeneration(input: LangfuseGenerationInput) {
				try {
					const details: Record<string, number> | undefined = input.usage
						? (Object.fromEntries(
								Object.entries({
									input: input.usage.inputTokens,
									output: input.usage.outputTokens,
									total: input.usage.totalTokens,
								}).filter(([, v]) => v !== undefined),
							) as Record<string, number>)
						: undefined;
					const gen = root.startObservation(
						input.name,
						{
							input: input.input,
							output: input.output,
							model: input.model,
							...(input.metadata ? { metadata: input.metadata } : {}),
							...(details && Object.keys(details).length > 0
								? { usageDetails: details }
								: {}),
						},
						{ asType: "generation" as const },
					);
					gen.end();
				} catch {
					// 計装の失敗で推論を壊さない
				}
			},
			recordSpan(input: LangfuseSpanInput) {
				try {
					const span = root.startObservation(
						input.name,
						{
							input: input.input,
							output: input.output,
							metadata: input.metadata,
							...(input.level ? { level: input.level } : {}),
							...(input.statusMessage
								? { statusMessage: input.statusMessage }
								: {}),
						},
						{ asType: "tool" as const },
					);
					span.end();
				} catch {
					// 計装の失敗で推論を壊さない
				}
			},
			end(endOptions) {
				try {
					if (endOptions.outcome === "failed") {
						root.update({
							level: "ERROR",
							statusMessage: endOptions.errorMessage ?? "inference failed",
						});
					}
					if (endOptions.output !== undefined) {
						root.update({ output: endOptions.output });
					}
					root.end();
				} catch {
					// 計装の失敗で推論を壊さない
				} finally {
					flushLangfuse();
				}
			},
		};
	} catch {
		return null;
	}
}

/** テストから provider をリセットする(isolate 内の singleton をクリア)。 */
export function __resetLangfuseForTests(): void {
	setLangfuseTracerProvider(null);
	provider = null;
	processor = null;
}
