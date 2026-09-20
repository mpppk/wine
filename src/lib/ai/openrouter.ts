// OpenRouter(chat completions)への接続層。**全AI機能のLLM呼び出しはここだけを通す**(#602)。
//
// OpenAI / Anthropic / Workers AI への個別接続は廃止した。接続先の集約であり、
// 利用モデルの限定ではない —— モデルID・許可リスト・用途別の推論設定は
// `config.ts` が持ち、ここは「OpenRouterへ投げて結果を共通形で返す」 transport に
// 専念する(OpenAI直結の Responses API を前提にせず、base URL の置換だけで
// 移行完了としない。#602 の選定記録)。
//
// 設計:
//  - Workers で動く素の fetch のみ。新規の SDK 依存は足さない。
//  - web検索は `openrouter:web_search` サーバーツールでモデルに実行させる
//    (engine native = プロバイダのネイティブ検索へ転送。Anthropic には
//    `max_uses` がそのまま渡る)。回数課金ぶんは応答の
//    `usage.server_tool_use.web_search_requests` から取る。
//  - reasoning/thinking は OpenRouter の統一 `reasoning` パラメータで渡す
//    (effort 形式も max_tokens 形式も OpenRouter 側で各プロバイダへ分配される)。
//  - 認証失敗・残高不足・429・5xx・タイムアウト時は**他プロバイダへ直接
//    フォールバックしない**。呼び出し側の既存のエラー表示・返却処理に載せるため
//    `OpenRouterError` として投げる。
//  - OpenRouter 内の配信プロバイダーのルーティング(`provider`)と、アプリによる
//    別モデルへの切り替えは別物。前者はここ(`OPENROUTER_PROVIDER_ROUTING`)で
//    一元管理し、後者は `config.ts` の resolve 関数が担う。別モデルへの自動
//    フォールバックは導入しない(#602)。
//
// 観測の規律:
//  - Langfuse への報告は呼び出し側が `ctx.recordGeneration()` で行う。ここで
//    `startObservation` を直書きしない(`langfuse.ts` が唯一の入口)。
//  - プロンプト本文の正は Langfuse(`getManagedPrompt`)。ここは本文を組み立てない。

import type { AiUsage } from "#/lib/billing/ai-pricing";
import { HttpError } from "#/lib/errors";

/** OpenRouter chat completions のエンドポイント。 */
export const OPENROUTER_API_URL =
	"https://openrouter.ai/api/v1/chat/completions";

/**
 * 1リクエストのタイムアウト(ms)。応答が銘柄数に比例する一括抽出(最大 32k 出力 +
 * web検索20回)でも打ち切らないよう余裕を持たせる。超過時は `OpenRouterError`
 * (code: "timeout") として投げ、呼び出し側の返却処理に載せる。
 */
const OPENROUTER_TIMEOUT_MS = 180_000;

/**
 * OpenRouter 内の配信プロバイダーのルーティング条件。**アプリによる別モデルへの
 * 切り替えとは別物**で、同一モデルIDの配信先の選択だけを制御する。予約見積と
 * 実測計上はモデルID基準なので、配信先が変わっても単価は変わらない。
 *
 * `allow_fallbacks: true` は OpenRouter の既定と同じ。主配信先の障害時に同一
 * モデルの別配信へ OpenRouter 側で振り替えることを明示的に許す。黙って別モデルへ
 * 切り替えることはない(OpenRouter の仕様)。
 */
const OPENROUTER_PROVIDER_ROUTING = {
	allow_fallbacks: true,
} as const;

/** OpenRouter への帰属表示(任意だが推奨)。課金・制限には影響しない。 */
const OPENROUTER_REFERER = "https://wine.nibo.sh";
const OPENROUTER_TITLE = "wine";

// ---- メッセージ・ツール・応答の形(OpenAI chat completions 互換) ----

/** テキストパート。 */
interface OpenRouterTextPart {
	type: "text";
	text: string;
}

/** 画像パート。data URI をそのまま渡す(HTTP URL は不可。parseImageDataUrl で強制)。 */
interface OpenRouterImagePart {
	type: "image_url";
	image_url: { url: string };
}

/** 写真番号の対応づけ等に使う user メッセージの組み立て用。 */
export type OpenRouterUserContent = Array<
	OpenRouterTextPart | OpenRouterImagePart
>;

/** モデルへの入力メッセージ。履歴・画像・ツール結果を載せる。 */
export type OpenRouterMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | OpenRouterUserContent }
	| {
			role: "assistant";
			content?: string | null;
			/** クライアント形。送信時に OpenAI の wire 形へ直す。 */
			tool_calls?: OpenRouterToolCall[];
	  }
	| {
			role: "tool";
			tool_call_id: string;
			content: string | OpenRouterUserContent;
	  };

/** アプリ側で実行する function ツールの定義。 */
export interface OpenRouterFunctionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
}

/**
 * `openrouter:web_search` サーバーツールの定義。モデルが検索の要否・回数を決め、
 * OpenRouter 側で実行する。engine native = プロバイダのネイティブ検索へ転送
 * (OpenAI / Anthropic / Google 等。それ以外は要確認のため native を明示し、
 *  黙って Exa 等へ落ちる余地を作らない)。
 */
interface OpenRouterWebSearchTool {
	type: "openrouter:web_search";
	parameters?: {
		/** プロバイダのネイティブ検索を使う。未対応モデルではエラーになる。 */
		engine?: "native";
		/** 1リクエストで許可する検索回数の上限(Anthropic ネイティブへ転送される)。 */
		max_uses?: number;
		/** 検索結果の量(OpenAI ネイティブは無視するが、既定 medium と同じ意味)。 */
		search_context_size?: "low" | "medium" | "high";
		/** 全検索呼び出しを通じた結果総数の上限(原価・文脈の歯止め)。 */
		max_total_results?: number;
	};
}

export type OpenRouterTool = OpenRouterFunctionTool | OpenRouterWebSearchTool;

/** structured outputs の指定。strict はスキーマが条件を満たすときに使う。 */
export interface OpenRouterResponseFormat {
	type: "json_schema";
	json_schema: {
		name: string;
		schema: Record<string, unknown>;
		strict?: boolean;
	};
}

/**
 * reasoning/thinking の統一指定(OpenRouter が各プロバイダへ分配する)。
 * - `effort`: OpenAI 式。low/medium/high のほか "none"(無効化)・"minimal" を取れる。
 * - `max_tokens`: Anthropic 式の内訳上限(1024 以上)。
 */
export interface OpenRouterReasoning {
	effort?: "none" | "minimal" | "low" | "medium" | "high";
	max_tokens?: number;
}

export interface OpenRouterChatRequest {
	model: string;
	messages: OpenRouterMessage[];
	tools?: OpenRouterTool[];
	/** 出力形式の強制。Anthropic 系の指示文のみの担保と違い、形を保証する。 */
	responseFormat?: OpenRouterResponseFormat;
	/** 生成の上限。reasoning トークンもこの枠から出る。 */
	maxTokens?: number;
	/** 省略時はモデルの既定(呼び出し側で effort 無指定と同義)。 */
	reasoning?: OpenRouterReasoning;
	timeoutMs?: number;
}

/** モデルが返した function ツール呼び出し。引数は JSON 文字列(パースは呼び出し側)。 */
interface OpenRouterToolCall {
	id: string;
	name: string;
	arguments: string;
}

/**
 * 応答メッセージに付く引用アノテーション。web検索の結果 URL を含み、
 * 「見ていないサイトの引用」の検証と検索の軌跡の組み立てに使う。
 */
interface OpenRouterAnnotation {
	type: string;
	url_citation?: {
		url?: string;
		title?: string;
		content?: string;
	};
}

export interface OpenRouterChatResult {
	/** 応答本文(無いこともある。呼び出し側が空の扱いを決める)。 */
	text: string;
	/** アプリ側で実行すべき function 呼び出し(サーバーツールは実行済み)。 */
	toolCalls: OpenRouterToolCall[];
	/** OpenRouter が正規化した終了理由。 */
	finishReason: string;
	/** プロバイダ固有の生の終了理由(切り分け用)。 */
	nativeFinishReason?: string;
	/** 課金計上用の使用量。web検索回数は server_tool_use から取る。 */
	usage: AiUsage;
	/** 引用アノテーション(web検索を使った回のみ付く)。 */
	annotations: OpenRouterAnnotation[];
	/** 実際に応答した配信プロバイダ(観測用。取得できるときだけ)。 */
	provider?: string;
}

// ---- エラー ----

/** OpenRouter 呼び出しの失敗分類。呼び出し側の表示・返却・通知の分岐に使う。 */
export type OpenRouterErrorCode =
	| "auth"
	| "insufficient_credits"
	| "rate_limited"
	| "bad_request"
	| "provider_error"
	| "timeout"
	| "network";

/**
 * OpenRouter 呼び出しの失敗。**他プロバイダへの直接フォールバックはしない**——
 * 呼び出し側の既存のエラー表示・返却処理に載せる。status は server function の
 * 境界で HTTP ステータスへ写る(`HttpError` 派生)。
 *
 * - auth/insufficient_credits/bad_request は運用・実装の問題なので 500 + 通知対象。
 * - rate_limited は 429 のまま利用者に待ってもらう。
 * - provider_error/timeout/network は 502(上流の一時失敗)。
 */
export class OpenRouterError extends HttpError {
	readonly code: OpenRouterErrorCode;
	constructor(code: OpenRouterErrorCode, message: string) {
		super(
			code === "rate_limited"
				? 429
				: code === "bad_request" ||
						code === "auth" ||
						code === "insufficient_credits"
					? 500
					: 502,
			message,
		);
		this.name = "OpenRouterError";
		this.code = code;
	}
}

// ---- usage 変換 ----

/**
 * OpenRouter の usage をクレジット計上用の `AiUsage` へ変換する。
 *
 * **入力・出力・キャッシュ・web検索を畳まずに分けて返す**(`toAnthropicUsage` と
 * 同じ規律)。単価が5倍・1/10・回数課金と違うため、合計トークンからは原価を
 * 復元できない。
 *
 * - `prompt_tokens` はキャッシュヒットを内数として含む(OpenAI 互換)ので、
 *   `cached_tokens` を差し引いて非キャッシュ入力とする(二重計上を避ける)。
 * - reasoning トークンは `completion_tokens` の内数として課金される。別建てで
 *   足すと二重加算になるので、`reasoning_tokens` は**読まない**。
 * - web検索回数は `server_tool_use.web_search_requests` から取る。Anthropic
 *   ネイティブ経由でも同じ場所に出る(OpenRouter が正規化する)。
 * - プロンプトキャッシュの書き込みはこちらからは使わない(cache_control を
 *   付けない)ので、書き込みトークンが来ても計上しない(無料のトークンに課金
 *   しない。旧 `toGptUsage` と同じ判断)。
 *
 * SDK の型に合わせにいかず unknown で受ける(応答の形が版で動いても、数え漏れに
 * ならず 0 扱いで続行する。web-research-trace.ts と同じ方針)。
 */
export function toOpenRouterUsage(usage: unknown): AiUsage {
	if (!usage || typeof usage !== "object") return {};
	const u = usage as Record<string, unknown>;
	const prompt = asNonNegativeInt(u.prompt_tokens);
	const completion = asNonNegativeInt(u.completion_tokens);
	const details =
		u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
			? (u.prompt_tokens_details as Record<string, unknown>)
			: undefined;
	const cached = asNonNegativeInt(details?.cached_tokens);
	// Anthropic ネイティブの形で来た場合の予備。OpenRouter は正規化するが、
	// 形が残っていたときにキャッシュ読みの割引を落とさないための防御。
	const nativeCacheRead = asNonNegativeInt(
		(u.cache_read_input_tokens as number | null | undefined) ??
			details?.cache_read_input_tokens,
	);
	const cacheRead = Math.max(cached, nativeCacheRead);
	const serverToolUse =
		u.server_tool_use && typeof u.server_tool_use === "object"
			? (u.server_tool_use as Record<string, unknown>)
			: undefined;
	return {
		inputTokens: Math.max(0, prompt - cacheRead),
		outputTokens: completion,
		cacheReadTokens: cacheRead,
		webSearches: asNonNegativeInt(serverToolUse?.web_search_requests),
	};
}

function asNonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0;
}

// ---- 実行 ----

/**
 * OpenRouter へ chat completion を1回投げる。**ツールループは回さない**——
 * function 呼び出しの実行・再送は呼び出し側(エージェントループ)が担い、
 * サーバーツール(web検索)は OpenRouter 側で1リクエストの中で完結する。
 *
 * キー未設定の検知は呼び出し側が予約の前に行う(`labelProviderAvailability` 等)。
 * ここでは空キーを送らない(401 を無駄に叩かない)。
 */
export async function chatCompletion(
	apiKey: string,
	request: OpenRouterChatRequest,
): Promise<OpenRouterChatResult> {
	if (!apiKey.trim()) {
		throw new OpenRouterError("auth", "OpenRouter APIキーが設定されていません");
	}
	const body: Record<string, unknown> = {
		model: request.model,
		messages: serializeMessages(request.messages),
		provider: OPENROUTER_PROVIDER_ROUTING,
	};
	if (request.tools && request.tools.length > 0) body.tools = request.tools;
	if (request.responseFormat) body.response_format = request.responseFormat;
	if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
	if (request.reasoning) body.reasoning = request.reasoning;
	let response: Response;
	try {
		response = await fetch(OPENROUTER_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": OPENROUTER_REFERER,
				"X-Title": OPENROUTER_TITLE,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(request.timeoutMs ?? OPENROUTER_TIMEOUT_MS),
		});
	} catch (e) {
		throw toNetworkError(e);
	}
	if (!response.ok) {
		throw await toStatusError(response);
	}
	const raw = (await response.json()) as Record<string, unknown>;
	return parseChatResult(raw);
}

/**
 * assistant メッセージのツール呼び出しを OpenAI の wire 形へ直す。
 * クライアント側は `{id, name, arguments}` の読みやすい形で持ち、
 * 送信時だけ `{id, type: "function", function: {name, arguments}}` にする。
 */
function serializeMessages(messages: OpenRouterMessage[]): unknown[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || !message.tool_calls) return message;
		const { tool_calls, ...rest } = message;
		return {
			...rest,
			tool_calls: tool_calls.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			})),
		};
	});
}

/** fetch 自体の失敗(タイムアウト・DNS・接続断)を `OpenRouterError` へ畳む。 */
function toNetworkError(e: unknown): OpenRouterError {
	const name =
		e && typeof e === "object" && "name" in e
			? String((e as { name: unknown }).name)
			: "";
	if (name === "TimeoutError") {
		return new OpenRouterError(
			"timeout",
			`OpenRouterへのリクエストがタイムアウトしました(${OPENROUTER_TIMEOUT_MS}ms)`,
		);
	}
	return new OpenRouterError(
		"network",
		`OpenRouterへの接続に失敗しました(${name || "fetch failed"})`,
	);
}

/**
 * 非2xx を `OpenRouterError` へ畳む。**秘密情報はメッセージに載せない**
 * (本文はプロバイダのエラー文の先頭だけに切り詰める)。
 */
async function toStatusError(response: Response): Promise<OpenRouterError> {
	const status = response.status;
	let detail = "";
	try {
		const raw = (await response.json()) as Record<string, unknown>;
		const err =
			raw.error && typeof raw.error === "object"
				? (raw.error as Record<string, unknown>)
				: undefined;
		const message = err?.message;
		if (typeof message === "string") detail = message.slice(0, 200);
	} catch {
		// 本文が読めなくても分類は続ける。
	}
	const suffix = detail ? `: ${detail}` : "";
	if (status === 401 || status === 403) {
		return new OpenRouterError(
			"auth",
			`OpenRouterの認証に失敗しました(${status})${suffix}`,
		);
	}
	if (status === 402) {
		return new OpenRouterError(
			"insufficient_credits",
			`OpenRouterの残高が不足しています(402)${suffix}`,
		);
	}
	if (status === 429) {
		return new OpenRouterError(
			"rate_limited",
			`OpenRouterが混雑しています(429)。しばらく待ってからもう一度お試しください${suffix}`,
		);
	}
	if (status === 400) {
		return new OpenRouterError(
			"bad_request",
			`OpenRouterへのリクエストが不正です(400)${suffix}`,
		);
	}
	return new OpenRouterError(
		"provider_error",
		`OpenRouterで一時的なエラーが発生しました(${status})${suffix}`,
	);
}

/**
 * 応答 JSON を共通形へ畳む。content は文字列とパート配列の両対応
 * (text パートだけを連結し、reasoning パートは本文に混ぜない)。
 */
function parseChatResult(raw: Record<string, unknown>): OpenRouterChatResult {
	const choice = (Array.isArray(raw.choices) ? raw.choices : [])[0] as
		| Record<string, unknown>
		| undefined;
	const message =
		choice?.message && typeof choice.message === "object"
			? (choice.message as Record<string, unknown>)
			: {};
	const text = extractText(message.content);
	const toolCalls = extractToolCalls(message.tool_calls);
	const annotations = Array.isArray(message.annotations)
		? (message.annotations as OpenRouterAnnotation[])
		: [];
	const finishReason =
		typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop";
	const nativeFinishReason =
		typeof choice?.native_finish_reason === "string"
			? choice.native_finish_reason
			: undefined;
	const provider =
		raw.provider && typeof raw.provider === "string" ? raw.provider : undefined;
	return {
		text,
		toolCalls,
		finishReason,
		...(nativeFinishReason ? { nativeFinishReason } : {}),
		usage: toOpenRouterUsage(raw.usage),
		annotations,
		...(provider ? { provider } : {}),
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const p = part as Record<string, unknown>;
			if (p.type === "text" && typeof p.text === "string") return p.text;
			return "";
		})
		.join("");
}

function extractToolCalls(toolCalls: unknown): OpenRouterToolCall[] {
	if (!Array.isArray(toolCalls)) return [];
	const out: OpenRouterToolCall[] = [];
	for (const call of toolCalls) {
		if (!call || typeof call !== "object") continue;
		const c = call as Record<string, unknown>;
		const fn =
			c.function && typeof c.function === "object"
				? (c.function as Record<string, unknown>)
				: undefined;
		const id = typeof c.id === "string" ? c.id : undefined;
		const name = typeof fn?.name === "string" ? fn.name : undefined;
		if (!id || !name) continue;
		out.push({
			id,
			name,
			arguments: typeof fn?.arguments === "string" ? fn.arguments : "{}",
		});
	}
	return out;
}
