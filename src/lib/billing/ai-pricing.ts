// AI推論の実原価（コスト単位）の SSOT。**モデル/プロバイダごとの単価はここだけに置く**。
//
// クレジットの内部計上は元々「消費トークン数」だけで行っていたが(#355)、
// 高精度エチケット解析(Claude / GPT + web検索)が加わって経路ごとの実費差が1000倍に
// なり、「opus の1トークン」と「gemma の1トークン」が同じ1トークンとして課金される
// 状態になっていた。さらに web検索は**回数課金**($10/1000回)で、トークン基準では
// 原理的に表現できず**まったく計上されていなかった**。
//
// 単位は µUSD(マイクロUSD、整数)。ここで USD/MTok の数値をそのまま持つと
//
//     µUSD = トークン数 × (USD per MTok)
//
// という除算なしの恒等式が成り立つ(30,000 tok × 5 = 150,000 µUSD = $0.15)。
// 公式の価格表記をそのまま書き写せる形にしてあるので、価格改定時は数値だけ差し替える。
//
// **このモジュールは純粋(DB・env・logger 非依存)に保つ**。クライアント(解析前の
// 必要クレジット表示)も ai/config.ts 経由で読むため、サーバ専用の依存を持ち込むと
// クライアントバンドルに漏れる。単価未登録の警告ログは呼び出し側(ai-service)で出す。

/**
 * 1表示クレジットあたりのコスト単位(µUSD)。**1クレジット = $0.001**。
 *
 * この値が「クレジット」の定義そのもの。付与数(plans.ts)はここから逆算した
 * 月あたりの原価予算で決めている。
 */
export const MICRO_USD_PER_CREDIT = 1_000;

/**
 * サーバーサイドweb検索の1回あたり単価(µUSD)。Anthropic・OpenAI とも $10/1000回
 * = $0.01/回。検索結果のトークンは別途 input として課金されるので、これは
 * **トークンとは別建ての回数課金ぶん**。
 *
 * @see https://platform.claude.com/docs/en/about-claude/pricing (web search tool)
 * @see https://developers.openai.com/api/docs/pricing (web search)
 */
export const WEB_SEARCH_MICRO_USD_PER_CALL = 10_000;

/**
 * 1リクエストで予約できる最大コスト(µUSD)。暴走・過大請求のガード($0.40)。
 * プレミアムの月次付与(1500クレジット = $1.50)の3割弱に収まる値にしてあり、
 * 1回の推論が付与枠を一気に食い潰さないようにしている。
 */
export const AI_MAX_ESTIMATE_MICRO_USD = 400_000;

/** モデル1つぶんの単価。すべて USD per 1M tokens(= µUSD per token)。 */
export interface ModelPricing {
	/** 入力トークン単価。 */
	inputUsdPerMTok: number;
	/** 出力トークン単価。 */
	outputUsdPerMTok: number;
	/** プロンプトキャッシュ書き込み単価。省略時は入力と同額として扱う。 */
	cacheWriteUsdPerMTok?: number;
	/** プロンプトキャッシュ読み出し単価。省略時は入力と同額(=割引なし)として扱う。 */
	cacheReadUsdPerMTok?: number;
}

/**
 * モデルID → 単価。**モデルを足したらここにも足す**。
 * `ai-pricing.test.ts` が「実際に呼ぶモデルID(AI_LABEL_ROUTE_MODELS /
 * AI_REGION_QA_MODELS / AI_WINE_LIST_MODEL)がすべてこの表にある」ことを検証するので、
 * 単価の登録を忘れたまま経路を足すと CI が落ちる。
 *
 * 値の確認日: 2026-08-02(一次情報は各エントリの @see)。
 */
export const AI_MODEL_PRICING: Record<string, ModelPricing> = {
	// ---- Anthropic ----
	// @see https://platform.claude.com/docs/en/about-claude/pricing
	"claude-opus-5": {
		inputUsdPerMTok: 5,
		outputUsdPerMTok: 25,
		cacheWriteUsdPerMTok: 6.25, // 5分キャッシュ(1.25x)
		cacheReadUsdPerMTok: 0.5, // ヒット(0.1x)
	},
	/**
	 * **導入価格ではなく 2026-09-01 以降の標準価格($3/$15)を入れている。**
	 * 2026-08-31 までは導入価格 $2/$10 だが、そちらを書くと9月に入った瞬間から
	 * 黙って過小請求になる。過大請求側(ユーザ不利)ではなく、価格改定を跨いでも
	 * 原価を割らない側に倒す。
	 */
	"claude-sonnet-5": {
		inputUsdPerMTok: 3,
		outputUsdPerMTok: 15,
		cacheWriteUsdPerMTok: 3.75,
		cacheReadUsdPerMTok: 0.3,
	},

	// ---- OpenAI ----
	// @see https://developers.openai.com/api/docs/pricing
	// キャッシュは「cached input」の割引のみで、書き込み側の課金は無い。
	"gpt-5.6-luna": {
		inputUsdPerMTok: 0.2,
		outputUsdPerMTok: 1.2,
		cacheReadUsdPerMTok: 0.02,
	},

	// ---- Cloudflare Workers AI ----
	// 実課金は neuron 単位だが、公式の価格表がモデルごとにトークン単価へ換算した値を
	// 併記しているのでそれを使う($0.011 / 1,000 neurons が基準レート)。
	// @see https://developers.cloudflare.com/workers-ai/platform/pricing/
	"@cf/meta/llama-4-scout-17b-16e-instruct": {
		inputUsdPerMTok: 0.27,
		outputUsdPerMTok: 0.85,
	},
	"@cf/google/gemma-4-26b-a4b-it": {
		inputUsdPerMTok: 0.1,
		outputUsdPerMTok: 0.3,
	},
};

/**
 * 単価未登録モデルに使うフォールバック単価(表の中の最高単価)。
 *
 * **未登録を throw にしない**のは、settle が推論成功の**後**に走るため。ここで
 * throw すると成功した推論が失敗扱いになり、予約を全額返却した上で原価だけ出て
 * クレジットを取り損ねる(ユーザには成功した結果が返っているのに無課金)。
 * 「取りっぱぐれるより高めに取る」側へ倒し、警告は呼び出し側のログに出す。
 */
const FALLBACK_PRICING: ModelPricing = {
	inputUsdPerMTok: Math.max(
		...Object.values(AI_MODEL_PRICING).map((p) => p.inputUsdPerMTok),
	),
	outputUsdPerMTok: Math.max(
		...Object.values(AI_MODEL_PRICING).map((p) => p.outputUsdPerMTok),
	),
};

/**
 * モデルIDの単価を引く。**未登録なら `null`**。
 * 呼び出し側が「単価表に無いモデルを呼んでいる」ことを警告ログに出すために使う
 * (換算そのものは `usageToMicroUsd` がフォールバックで続行する)。
 */
export function getModelPricing(model: string): ModelPricing | null {
	return AI_MODEL_PRICING[model] ?? null;
}

/**
 * 推論1回ぶんの使用量。**見積(予約)と実測(確定)の両方をこの型で表す**。
 * 同じ型・同じ換算関数を通すことで、単価を改定したときに見積と確定の片方だけが
 * 古いままになることがない。
 */
export interface AiUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** プロンプトキャッシュへの書き込みトークン(Anthropic)。 */
	cacheWriteTokens?: number;
	/** プロンプトキャッシュから読んだトークン(Anthropic / OpenAI の cached input)。 */
	cacheReadTokens?: number;
	/** サーバーサイドweb検索の実行回数(トークンとは別建ての回数課金)。 */
	webSearches?: number;
}

/** 使用量をフィールドごとに足し合わせる(pause_turn の継続ループ・複数枚の逐次解析用)。 */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
	return {
		inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
		outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
		cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
		cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
		webSearches: (a.webSearches ?? 0) + (b.webSearches ?? 0),
	};
}

/** 使用量の総トークン数(台帳の `token_amount` と観測ログ用。課金には使わない)。 */
export function totalTokens(usage: AiUsage): number {
	return (
		(usage.inputTokens ?? 0) +
		(usage.outputTokens ?? 0) +
		(usage.cacheWriteTokens ?? 0) +
		(usage.cacheReadTokens ?? 0)
	);
}

/**
 * 使用量を実原価(µUSD、切り上げ)へ換算する。**課金の唯一の換算点**。
 *
 * 端数は切り上げる(表示クレジットへの換算 `costToCredits` と同じく過小請求を避ける側)。
 */
export function usageToMicroUsd(model: string, usage: AiUsage): number {
	const p = getModelPricing(model) ?? FALLBACK_PRICING;
	const cacheWrite = p.cacheWriteUsdPerMTok ?? p.inputUsdPerMTok;
	const cacheRead = p.cacheReadUsdPerMTok ?? p.inputUsdPerMTok;
	const micro =
		(usage.inputTokens ?? 0) * p.inputUsdPerMTok +
		(usage.outputTokens ?? 0) * p.outputUsdPerMTok +
		(usage.cacheWriteTokens ?? 0) * cacheWrite +
		(usage.cacheReadTokens ?? 0) * cacheRead +
		(usage.webSearches ?? 0) * WEB_SEARCH_MICRO_USD_PER_CALL;
	return Math.ceil(micro);
}

/**
 * 見積を `AI_MAX_ESTIMATE_MICRO_USD` でクランプする。予約の入口で必ず通す
 * (旧 `AI_MAX_ESTIMATE_TOKENS` と同じ役割)。
 */
export function clampEstimateMicroUsd(microUsd: number): number {
	return Math.min(AI_MAX_ESTIMATE_MICRO_USD, microUsd);
}
