import type { AiUsage } from "#/lib/billing/ai-pricing";

// AI SDK(`ai` パッケージ)の usage をクレジット計上用の `AiUsage` へ変換する純ロジック。
//
// AI SDK は usage を**プロバイダ横断の共通形へ正規化する**ので、プロバイダごとの
// マッパー(`toGptUsage` / `toAnthropicUsage`)と違い1つで足りる。ただし
// **生の usage を保持する `raw` は空で返ってくる**(実測で確認)ため、正規化後の形が
// 唯一の情報源になる。SDK の更新で内訳が欠けても CI は緑のまま原価だけ見えなくなるので、
// 取りこぼしの検出は usage-accounting.test.ts のガードに委ねる。
//
// SDK の型(`LanguageModelUsage`)に構造を合わせにいかず、必要な部分だけを自前の型で
// 受ける。判別共用体や省略可能フィールドが版ごとに動くため、合わせにいくとテスト用の
// ダミー値が組み立てられなくなる(web-research-trace.ts と同じ方針)。

/** AI SDK の usage のうち、計上に使う部分。 */
export interface AiSdkUsage {
	inputTokens?: number;
	inputTokenDetails?: {
		/** キャッシュヒットを除いた入力トークン。 */
		noCacheTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
	outputTokens?: number;
}

export interface AiSdkUsageOptions {
	/**
	 * サーバー実行された web検索の回数。**usage には出ない**($10/1000回 の回数課金)ので
	 * 呼び出し側が `countProviderExecutedCalls` の結果を渡す。
	 */
	webSearches: number;
	/**
	 * キャッシュ書き込みを計上するか。**プロバイダで違うので呼び出し側が明示する**。
	 *
	 * Anthropic は書き込みを課金する(単価表に `cacheWriteUsdPerMTok` がある)が、
	 * OpenAI は課金しない(割引は cached input 側だけ)。`usageToMicroUsd` は単価未定義の
	 * キャッシュ書き込みを**入力単価**で換算する安全側の既定なので、OpenAI で計上すると
	 * 無料のトークンに課金することになる。既定値を置かずに毎回書かせるのは、
	 * プロバイダを足したときに黙って一方の挙動を引き継がせないため。
	 */
	billCacheWrites: boolean;
}

/**
 * AI SDK の usage を `AiUsage` へ変換する。
 *
 * `inputTokens` は**キャッシュヒットを内数として含む**。SDK は差し引き済みの値を
 * `inputTokenDetails.noCacheTokens` で返すので原則そちらを使い、欠けている場合だけ
 * 自前で差し引く(二重計上を避ける)。
 */
export function toAiSdkUsage(
	usage: AiSdkUsage | undefined,
	options: AiSdkUsageOptions,
): AiUsage {
	const details = usage?.inputTokenDetails;
	const cacheRead = details?.cacheReadTokens ?? 0;
	const inputTokens =
		details?.noCacheTokens ??
		Math.max(0, (usage?.inputTokens ?? 0) - cacheRead);
	return {
		inputTokens,
		outputTokens: usage?.outputTokens ?? 0,
		cacheReadTokens: cacheRead,
		// 課金しないプロバイダでは 0 のまま返す(拾うと入力単価で過大請求になる)。
		cacheWriteTokens: options.billCacheWrites
			? (details?.cacheWriteTokens ?? 0)
			: 0,
		webSearches: options.webSearches,
	};
}

/**
 * 指定したツール名の呼び出し回数を数える。
 *
 * サーバー実行ツール(web検索など)の**実行回数は usage に出ない**ため、計上するには
 * ツール呼び出しを数えるしかない。Luna は原価の大半が web検索の回数課金なので、
 * ここを落とすと経路の原価がほぼ見えなくなる(#355 で実際に漏れていた)。
 */
export function countProviderExecutedCalls(
	toolCalls: readonly unknown[] | undefined,
	toolName: string,
): number {
	let count = 0;
	for (const call of toolCalls ?? []) {
		if (!call || typeof call !== "object") continue;
		if ((call as { toolName?: unknown }).toolName === toolName) count++;
	}
	return count;
}

/** `accumulateStepUsage` が受け取るステップの必要部分。 */
export interface AiSdkStep {
	usage?: AiSdkUsage;
	toolCalls?: readonly unknown[];
}

/**
 * ここまでのステップの usage を1つに合算する。**ループの途中で原価を見る**ために使う
 * (予算超過で打ち切る判定・実行記録)。
 *
 * `generateText` の戻り値の `usage` は全ステップ合算済みだが、**ループを止めるかどうかは
 * 戻る前に決めないといけない**ので、`stopWhen` に渡ってくるステップ列から自前で積む。
 * web検索の回数も同じ理由でステップをまたいで数える。
 */
export function accumulateStepUsage(
	steps: readonly AiSdkStep[],
	options: AiSdkUsageOptions & { webSearchToolName: string },
): AiUsage {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let webSearches = 0;
	for (const step of steps) {
		const usage = toAiSdkUsage(step.usage, {
			webSearches: countProviderExecutedCalls(
				step.toolCalls,
				options.webSearchToolName,
			),
			billCacheWrites: options.billCacheWrites,
		});
		inputTokens += usage.inputTokens ?? 0;
		outputTokens += usage.outputTokens ?? 0;
		cacheReadTokens += usage.cacheReadTokens ?? 0;
		cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		webSearches += usage.webSearches ?? 0;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		webSearches,
	};
}
