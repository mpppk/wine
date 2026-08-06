import { env } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import Anthropic from "@anthropic-ai/sdk";
import { generateText } from "ai";
import OpenAI from "openai";
import {
	countProviderExecutedCalls,
	toAiSdkUsage,
} from "#/lib/ai/ai-sdk-usage";
import {
	AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
	AI_LABEL_GPT_MODEL,
	AI_LABEL_GPT_REASONING_EFFORT,
	AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
	AI_LABEL_MAX_OUTPUT_TOKENS,
	AI_LABEL_MODEL,
	AI_LABEL_ROUTE_MODELS,
	AI_LABEL_WEB_MAX_CONTINUATIONS,
	AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
	AI_LABEL_WEB_MAX_SEARCHES,
	AI_LABEL_WEB_MODEL,
	AI_MAX_OUTPUT_TOKENS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_GPT_REASONING_EFFORT,
	AI_WINE_LIST_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_ROUTE_MODELS,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REGION_QA_MODEL,
	estimateLabelReserveCharge,
	estimateRegionQaReserveCharge,
	estimateWineListReserveCharge,
	type LabelRoute,
	type RegionQaModelKey,
	resolveLabelRoute,
	resolveWineListRoute,
	toLabelEngineKey,
	toRegionQaModelKey,
	type WineListRoute,
} from "#/lib/ai/config";
import {
	buildLabelMessages,
	buildLabelSuggestions,
	extractJsonPayload,
	LABEL_JSON_SCHEMA,
	type LabelExtraction,
	type LabelFieldSources,
	type LabelSuggestions,
	mergeExtractions,
	parseLabelResponse,
	parseLabelSources,
} from "#/lib/ai/label-extraction";
import {
	assertGptLabelFinished,
	buildGptLabelMessages,
	buildGptLabelOutput,
	GPT_WEB_SEARCH_TOOL_NAME,
} from "#/lib/ai/label-gpt-research";
import {
	buildWebLabelMessages,
	joinResponseText,
	toAnthropicUsage,
} from "#/lib/ai/label-web-research";
import {
	buildRegionChatMessages,
	type ChatMessage,
	estimateInputTokens,
	type RegionContextInput,
	stripReasoning,
} from "#/lib/ai/region-qa";
import {
	extractAiSdkWebSearchTrace,
	extractAnthropicTrace,
	type WebResearchTrace,
} from "#/lib/ai/web-research-trace";
import {
	buildWineListCandidates,
	buildWineListMessages,
	dedupeWineListItems,
	matchExistingEntries,
	parseWineListResponse,
	WINE_LIST_TRUNCATED_ERROR_MESSAGE,
	type WineListCandidate,
	type WineListParseResult,
	type WineListSubject,
} from "#/lib/ai/wine-list-extraction";
import {
	buildWineListGptInput,
	buildWineListGptTextFormat,
	extractWineListGptText,
	toGptUsage,
} from "#/lib/ai/wine-list-gpt";
import { toWorkersAiUsage } from "#/lib/ai/workers-ai-usage";
import {
	type AiUsage,
	addUsage,
	type CreditCharge,
	getModelPricing,
	toCharge,
} from "#/lib/billing/ai-pricing";
import { BadRequestError, HttpError } from "#/lib/errors";
import { logWarn } from "#/lib/logger";
import { alertOperator } from "#/lib/observability/operator-alert";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import { runMeteredInference } from "#/lib/services/metered-inference";
import * as userService from "#/lib/services/user-service";
import { getAop, getRegion, getVariety, listAops } from "#/lib/wine/service";

/**
 * 実測 usage を計上量へ畳む**唯一の関門**(#355)。
 *
 * `model` は「意図した経路」ではなく**実際に推論したモデル**を渡すこと。エチケット解析は
 * 高精度経路が失敗すると Workers AI へフォールバックするので、意図した経路のモデルで
 * 換算すると Opus の単価で Llama の推論を課金してしまう。
 *
 * 単価未登録のモデルはここで警告を出す(換算自体はフォールバック単価で続行する。理由は
 * ai-pricing.ts の FALLBACK_PRICING を参照)。**経路ごとに書かず1箇所に寄せる**ので、
 * 経路が増えても警告の付け忘れが起きない。
 */
function chargeFor(model: string, usage: AiUsage): CreditCharge {
	if (getModelPricing(model) === null) {
		// 単価表に無いモデルで課金している = **請求は続くのに原価が読めない**。
		// 価格表を直すまで解消しないので通知する(#395)。
		alertOperator(
			"ai pricing missing; charging at fallback rate",
			{ model },
			{ level: "warning", tags: { kind: "ai_pricing_missing" } },
		);
	}
	return toCharge(model, usage);
}

/**
 * 実測が取れなかったときの確定値。渡した見積額を実測とみなす。
 * トークンは観測できていないので 0 のままにし、**推定値を実測として台帳に残さない**。
 *
 * **渡すのは「実際に走った経路」の見積**であって予約額ではない(#404)。単経路の機能
 * (地域Q&A・ワインリスト解析)では両者は同じ値だが、エチケット解析は高精度経路が
 * 失敗すると Workers AI へ降格するため、予約額を渡すと Llama 1回の推論に高精度経路の
 * 予約全量(例: 275クレジット)を課金してしまう。
 */
function fallbackCharge(estimateMicroUsd: number): CreditCharge {
	return { microUsd: estimateMicroUsd, tokens: 0 };
}

/**
 * このターンで使うモデルキーを解決する。明示指定(MCP 等の override)を最優先し、
 * 無ければユーザのプロフィール設定(preferredAiModel)を使う。どちらも無効/未設定なら既定。
 * モデル選択は原則プロフィール画面で行うため、通常の Web チャットは explicit を渡さない。
 */
async function resolveModelKey(
	userId: string,
	explicit?: RegionQaModelKey,
): Promise<RegionQaModelKey> {
	if (explicit) return explicit;
	const { preferredAiModel } = await userService.getCurrentUser(userId);
	// 書き込み側(auth.ts の validator)と同じ許可リストで照合する。書き込みを塞いだ後も
	// 既存行に残る旧データ・不正値がありうるため、読み取り側のフォールバックは残す。
	return toRegionQaModelKey(preferredAiModel) ?? DEFAULT_REGION_QA_MODEL;
}

// 地域チャットQ&Aのサービス層。Web サーバfn と MCP ツールの両方から呼ぶ単一の入口。
// グラウンディング材料を wine サービスから解決し、クレジット予約→(Workers AI 実行)→
// 実測確定/失敗時返却の骨格で1ターンを処理する。

export interface AskRegionInput {
	regionId: string;
	aopId?: string;
	question: string;
	/** クライアント保持の会話履歴(直近から。上限は region-qa 側でクランプ)。 */
	history?: ChatMessage[];
	/**
	 * 回答に使うモデルの明示指定(許可リストのキー)。省略時はユーザのプロフィール設定
	 * (preferredAiModel)を使う。Web チャットは通常省略し、MCP 等の override 用途で渡す。
	 */
	model?: RegionQaModelKey;
}

export type AskRegionResult =
	| { blocked: true; balance: number; required: number }
	| { blocked: false; answer: string; actualTokens: number; balance: number };

/** region/aop の静的データからグラウンディング材料を組み立てる。 */
function buildContext(regionId: string, aopId?: string): RegionContextInput {
	const region = getRegion(regionId);
	if (!region) throw new BadRequestError(`Unknown region: ${regionId}`);
	if (!region.enabled)
		throw new BadRequestError(`Region not yet available: ${regionId}`);

	const aopNames = listAops({ regionId }).map((a) => a.shortName);

	let aop: RegionContextInput["aop"];
	if (aopId) {
		const found = getAop(aopId);
		// 別地域のAOP idを渡された場合は無視(地域の文脈を汚さない)
		if (found && found.region === regionId) {
			aop = {
				nameJa: found.nameJa,
				shortName: found.shortName,
				kind: found.kind,
				soil: found.soil,
				description: found.description,
				grapeLabels: found.grapes.map(
					(g) => getVariety(g.varietyId)?.nameJa ?? g.varietyId,
				),
				producerNames: found.producers.map((p) => p.name),
			};
		}
	}

	return {
		regionNameJa: region.nameJa,
		regionNameLocal: region.nameLocal,
		countryJa: region.countryJa,
		regionDescription: region.description,
		subregionNames: region.subregions.map((s) => s.nameJa),
		aopNames,
		aop,
	};
}

/**
 * 地域についての質問に Workers AI で答え、実測トークンでクレジットを確定消費する。
 * 残高不足なら推論せず blocked を返す(throw しない)。推論失敗時は予約全額を返却して再throw。
 */
export async function answerRegionQuestion(
	userId: string,
	input: AskRegionInput,
): Promise<AskRegionResult> {
	const context = buildContext(input.regionId, input.aopId);
	const messages = buildRegionChatMessages({
		context,
		history: input.history ?? [],
		question: input.question,
	});
	const promptTokens = estimateInputTokens(messages);
	const requestId = `ask_region:${crypto.randomUUID()}`;

	// プロフィール設定(または明示指定)→ 実モデルID＋固有オプションに解決。
	// **予約より前**に解決する(#245)。明示指定が無ければ D1 を読むため、一時エラーや
	// NotFoundError で throw しうる。予約の後・try の外でこれを await すると、その throw が
	// 下の catch(refundReservationOnFailure)に届かず、予約が返却も記録もされずに消える。
	// モデル解決は予約と独立なので、先に済ませて「予約したら必ず try で囲まれている」形にする。
	const modelKey = await resolveModelKey(userId, input.model);
	const model = AI_REGION_QA_MODELS[modelKey];
	// 見積はモデルが決まってから作る。gemma4 と llama4 で単価が3倍違うため、
	// モデル解決より前に見積ると経路と原価が食い違う。
	const estimate = estimateRegionQaReserveCharge(modelKey, promptTokens);
	// 実行記録の共通部分。経路ごとに組み立て直すとフィールドがドリフトするため1つ持つ。
	const logBase = {
		feature: "region_qa",
		selected: modelKey,
		// 地域Q&Aはフォールバック経路が無いので、意図した経路＝実行経路。
		route: modelKey,
		model: model.id,
	} as const;

	const result = await runMeteredInference(
		userId,
		{ estimate, requestId, logBase },
		async (ctx) => {
			const raw = await env.AI.run(model.id, {
				messages,
				max_completion_tokens: AI_MAX_OUTPUT_TOKENS,
				// モデル固有オプションを展開。Gemma 4 は既定で thinking が有効で、放置すると
				// reasoning が出力枠(512)を先に使い切り本文(content)が途中で切れる/空になるため
				// extraOptions で enable_thinking=false を渡す(Llama 4 はこのオプション不要)。
				...model.extraOptions,
			});
			// レスポンス形式はモデルで異なるため両対応する:
			//  - Chat Completions 互換(Gemma 4 等): choices[0].message.content
			//  - 従来テキスト生成(Llama 系等): response
			// usage は両形式とも usage.total_tokens（無いモデルもあるため任意）。
			const out = raw as {
				response?: string;
				choices?: Array<{ message?: { content?: string | null } }>;
				usage?: { total_tokens?: number };
			};
			const rawText = out.choices?.[0]?.message?.content ?? out.response ?? "";
			// thinking 無効化済みだが、reasoning モデルへ差し替えても <think>…</think> を表示に出さない
			const answer = stripReasoning(rawText).trim();
			// Workers AI は入出力の内訳を返さないので、全量を出力単価で換算する(保守的=
			// 過大請求側)。この経路は原価がほぼゼロなので実害は無い。実測が取れなければ
			// 予約全量を実測とみなす —— **この機能は単経路で降格が無い**ので、予約額は
			// そのまま「実行された経路の見積」でもある(#404 のエチケット解析とは違う)。
			const measured = toWorkersAiUsage(out.usage);
			const charge =
				measured === undefined
					? fallbackCharge(ctx.reservedMicroUsd)
					: chargeFor(model.id, measured);
			// 単経路なので実行経路は選択経路と常に一致する。
			ctx.addLogFields({ executedBy: modelKey });
			return { value: answer, charge };
		},
	);
	if (result.blocked) {
		return {
			blocked: true,
			balance: result.balance,
			required: result.required,
		};
	}
	return {
		blocked: false,
		answer: result.value,
		actualTokens: result.charge.tokens,
		balance: result.balance,
	};
}

/**
 * このユーザのエチケット解析で**実際に走る経路**を返す。
 *
 * 解析前に必要クレジットを出すために UI が要る情報だが、経路はシークレットの設定状況
 * (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`)に依存するのでクライアントでは決められない。
 * 判定は analyzeWineLabel と**同じ resolveLabelRoute** を通すので、表示とサーバの
 * 予約が食い違わない(経路ごとに条件を書き分けるとドリフトする。#354 の教訓)。
 */
export async function resolveLabelRouteForUser(
	userId: string,
): Promise<LabelRoute> {
	const { preferredLabelEngine } = await userService.getCurrentUser(userId);
	const engine = toLabelEngineKey(preferredLabelEngine) ?? DEFAULT_LABEL_ENGINE;
	return resolveLabelRoute(engine, {
		openai: !!env.OPENAI_API_KEY?.trim(),
		anthropic: !!env.ANTHROPIC_API_KEY?.trim(),
	});
}

/** 高精度経路が使える環境か(プロフィールの選択カードに目安消費を出すために使う)。 */
export function labelProviderAvailability(): {
	openai: boolean;
	anthropic: boolean;
} {
	return {
		openai: !!env.OPENAI_API_KEY?.trim(),
		anthropic: !!env.ANTHROPIC_API_KEY?.trim(),
	};
}

export interface AnalyzeLabelInput {
	/**
	 * エチケット画像の data URI(data:image/...;base64,...)の配列。HTTP URLは不可。
	 * 同一ワインの複数写真を総合判断させる。最低1枚必要。
	 */
	imageDataUrls: string[];
}

export type AnalyzeLabelResult =
	| { blocked: true; balance: number; required: number }
	| {
			blocked: false;
			suggestions: LabelSuggestions;
			actualTokens: number;
			balance: number;
	  };

/** 高精度経路が返す、抽出結果と観測情報。 */
interface LabelResearchResult {
	extraction: LabelExtraction;
	usage: AiUsage;
	/** モデルが自己申告したフィールドごとの根拠。書かれていなければ undefined。 */
	fieldSources?: LabelFieldSources;
}

/**
 * 検索の軌跡の受け取り口。**戻り値ではなくコールバックで渡す**のは、応答のパースに
 * 失敗した回(= フォールバックする回)こそ「何を検索したか」を知りたいため。
 * 実装は応答を受け取り次第、パースより先にこれを呼ぶ。
 */
type WebResearchTraceSink = (trace: WebResearchTrace) => void;

/**
 * 高精度経路: Claude(マルチモーダル + サーバーサイドweb検索)で全写真を1リクエスト
 * 解析し、生産者公式サイト・ワインDBでの裏取り込みの抽出結果を返す。
 * env 非依存(apiKey を注入)で、失敗は throw する(フォールバック判断は呼び出し側)。
 */
async function analyzeLabelWithWebResearch(
	apiKey: string,
	imageDataUrls: string[],
	onTrace: WebResearchTraceSink,
): Promise<LabelResearchResult> {
	const client = new Anthropic({ apiKey });
	const request = {
		model: AI_LABEL_WEB_MODEL,
		max_tokens: AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
		tools: [
			{
				type: "web_search_20260209",
				name: "web_search",
				max_uses: AI_LABEL_WEB_MAX_SEARCHES,
			},
		],
	} satisfies Partial<Anthropic.MessageCreateParamsNonStreaming>;
	const messages = buildWebLabelMessages(imageDataUrls);

	let response = await client.messages.create({ ...request, messages });
	// 継続のたびに入力を再送するので、**内訳ごとに**加算する(合算スカラーだと
	// 入力・出力・web検索回数が混ざって原価を復元できない)。
	let usage = toAnthropicUsage(response.usage);
	// 検索の軌跡は継続をまたいで積む。各レスポンスは新しいブロックだけを含むので、
	// 全レスポンスぶんを連結すれば重複せず実行順のまま並ぶ。
	const blocks: unknown[] = [...response.content];
	onTrace(extractAnthropicTrace(blocks));
	// サーバー側ツールループ(web検索)が上限に達すると pause_turn で返る。assistant 応答を
	// 積んで再送すると続きから再開する(継続回数は原価ガードとして上限で打ち切る)。
	for (
		let i = 0;
		i < AI_LABEL_WEB_MAX_CONTINUATIONS && response.stop_reason === "pause_turn";
		i++
	) {
		messages.push({ role: "assistant", content: response.content });
		response = await client.messages.create({ ...request, messages });
		usage = addUsage(usage, toAnthropicUsage(response.usage));
		blocks.push(...response.content);
		onTrace(extractAnthropicTrace(blocks));
	}
	// claude-opus-5 はセーフティ分類器が HTTP 200 + stop_reason: "refusal" で応答を
	// 拒否しうる。content が空/不完全なので通常の失敗として扱う(Workers AI へフォールバック)。
	if (response.stop_reason === "refusal") {
		throw new Error("Claudeがエチケット解析の応答を拒否しました");
	}
	// 本文JSONは最終レスポンスに出る(pause_turn はツール実行中の中断で、その時点では
	// まだ本文を書き始めていない)。**軌跡と違い連結しない**: 継続前のテキストを混ぜると
	// extractJsonPayload の「最初の { 〜 最後の }」が別の断片を拾いうる。
	const payload = extractJsonPayload(joinResponseText(response.content));
	return {
		extraction: parseLabelResponse(payload),
		usage,
		// Claude は structured outputs を使えないので sources はプロンプトでしか要求できない。
		// 書かれていなければ undefined になる(パース側が欠落に耐える)。
		fieldSources: parseLabelSources(payload),
	};
}

/**
 * 高精度経路: OpenAI GPT-5.6 Luna(マルチモーダル + サーバーサイドweb検索)で全写真を
 * 1リクエスト解析する。Claude経路と同じ契約(env 非依存・失敗は throw してフォールバックは
 * 呼び出し側)で、返す形も揃える。
 *
 * **AI SDK(`ai` + `@ai-sdk/openai`)で呼ぶ**(#455 の実測で移行を決定。usage の内訳は
 * 生の Responses API と一致し、キャッシュ書き込みや reasoning の内訳はむしろ細かく取れる)。
 *
 * Claude経路と違い pause_turn の継続ループが要らない: web検索はプロバイダ実行ツールで、
 * ツールループをサーバー側で完走させてから1つの応答を返す。打ち切りは finishReason に
 * 畳まれるので、assertGptLabelFinished がそれを throw に変える。
 */
async function analyzeLabelWithGptResearch(
	apiKey: string,
	imageDataUrls: string[],
	onTrace: WebResearchTraceSink,
): Promise<LabelResearchResult> {
	const openai = createOpenAI({ apiKey });
	// 軌跡はステップ完了ごとに積む。**本文のパースより先に onTrace へ渡す**ため
	// (structured outputs の検証は generateText の中で走るので、打ち切られた回は
	// generateText 自体が throw する。戻り値を待ってから軌跡を組むと、
	// 「検索まで到達したが結果を使えなかった」回の観測が丸ごと落ちる)。
	const toolResults: unknown[] = [];
	const result = await generateText({
		model: openai(AI_LABEL_GPT_MODEL),
		messages: buildGptLabelMessages(imageDataUrls),
		tools: {
			[GPT_WEB_SEARCH_TOOL_NAME]: openai.tools.webSearch({
				searchContextSize: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			}),
		},
		output: buildGptLabelOutput(),
		maxOutputTokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
		providerOptions: {
			openai: { reasoningEffort: AI_LABEL_GPT_REASONING_EFFORT },
		},
		// **Workers では明示的に切る**。AI SDK の telemetry は Node の
		// `diagnostics_channel` を使うが、workerd(nodejs_compat)のシムは
		// `hasSubscribers` を返さないため無効化の分岐が働かず、tracePromise が
		// 呼び出しごとに派生 Promise を作る。その派生 Promise には誰も catch を
		// 付けないので、**推論が失敗するたびに未処理の Promise 拒否が残る**
		// (こちらは try/catch で受けて Workers AI へ降格しているのに、ランタイムには
		// 未処理として記録される)。OpenTelemetry の連携は使っておらず、観測は
		// logAiInference と Sentry で足りているので、切って困るものが無い。
		telemetry: { isEnabled: false },
		onStepFinish: (step) => {
			toolResults.push(...step.toolResults);
			onTrace(extractAiSdkWebSearchTrace(toolResults));
		},
	});
	assertGptLabelFinished(result.finishReason);
	// usage はサーバー側ツールループのぶんも合算済み。**web検索の回数だけは usage に
	// 出ない**のでツール呼び出しを数える($10/1000回 の回数課金で、Luna の原価の8割を占める)。
	const usage = toAiSdkUsage(result.usage, {
		webSearches: countProviderExecutedCalls(
			result.toolCalls,
			GPT_WEB_SEARCH_TOOL_NAME,
		),
		// OpenAI はキャッシュ書き込みを課金しない(拾うと入力単価で過大請求になる)。
		billCacheWrites: false,
	});
	const payload = result.output;
	return {
		extraction: parseLabelResponse(payload),
		usage,
		fieldSources: parseLabelSources(payload),
	};
}

/**
 * エチケット画像を解析し、マイセラーの自動入力候補を返す。
 * OPENAI_API_KEY / ANTHROPIC_API_KEY 設定時は LLM + web検索の高精度経路(裏取り込みの
 * 総合解析)を使い、キー未設定・実行失敗時は Workers AI(マルチモーダル)へ
 * フォールバックする。どの経路を走らせるかの判断は resolveLabelRoute が SSOT。
 * ユーザがプロフィールで標準(workers-ai)を選んでいる場合はキー設定時でも高精度を使わない。
 * クレジットの予約→実測確定/失敗時返却は answerRegionQuestion と同じ骨格。
 * 応答のパース失敗も「推論失敗」として予約を全額返却する。
 */
export async function analyzeWineLabel(
	userId: string,
	input: AnalyzeLabelInput,
): Promise<AnalyzeLabelResult> {
	if (input.imageDataUrls.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	// 高精度経路は「対応するシークレット設定あり かつ ユーザが標準を明示選択していない」
	// 場合のみ有効。env・ユーザ設定(D1読み)の解決は**予約より前**に済ませ、「予約したら
	// 必ず try で囲まれている」形を保つ(#245 と同じ理由)。
	// 見積は経路で異なる(web検索の結果取り込みぶん、高精度経路のほうが大きい)。
	const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;
	const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
	const { preferredLabelEngine } = await userService.getCurrentUser(userId);
	// 書き込み側(auth.ts の validator)と同じ許可リストで照合する。旧データ・不正値は
	// 既定(高精度)へフォールバックする(resolveModelKey と同じ流儀)。
	const engine = toLabelEngineKey(preferredLabelEngine) ?? DEFAULT_LABEL_ENGINE;
	const route = resolveLabelRoute(engine, {
		openai: !!openaiApiKey,
		anthropic: !!anthropicApiKey,
	});
	// 見積は経路で大きく違う(実費で標準 約3 / Luna 約39 / Claude 約275 クレジット)。
	// 経路 → 見積の対応は config.ts に寄せてあり、クライアントの必要クレジット表示も
	// 同じ関数を通る。
	const estimate = estimateLabelReserveCharge(
		route,
		input.imageDataUrls.length,
	);
	const requestId = `analyze_label:${crypto.randomUUID()}`;
	const logBase = {
		feature: "label_analysis",
		selected: engine,
		route,
		photoCount: input.imageDataUrls.length,
	} as const;

	const result = await runMeteredInference(
		userId,
		{ estimate, requestId, logBase },
		async (ctx) => {
			// 実際に結果を出した経路。高精度経路が失敗すると route と食い違う(=フォールバック)。
			// route だけを記録すると「GPTで成功」と「GPTが落ちてWorkers AIが拾った」を
			// 区別できないため、別に持って実行記録に載せる。
			let executedBy: LabelRoute | undefined;
			/** 実行経路が確定したら実行記録にも反映する(降格した回も失敗した回も残る)。 */
			const markExecutedBy = (executed: LabelRoute) => {
				executedBy = executed;
				ctx.addLogFields({
					executedBy: executed,
					model: AI_LABEL_ROUTE_MODELS[executed],
				});
			};
			// 裏取りの観測情報(webResearch / fieldSources)は**判明した時点で** ctx に積む。
			// ラッパーが ok と failed の両方の実行記録に載せるので、高精度経路が落ちて
			// Workers AI へ降格した回や推論そのものが失敗した回にも残る —— 「検索まで
			// 到達したが結果を使えなかった」ことが分かるのはここだけ(#392)。
			let usage: AiUsage = {};
			const extractions: LabelExtraction[] = [];

			// 高精度経路: LLM + web検索で全写真を1リクエスト総合解析する。失敗しても全体を
			// 落とさず、従来の Workers AI 経路へフォールバックする(可用性を落とさない)。
			// **失敗時にもう一方の高精度プロバイダは試さない**: 予約は選んだ経路の見積で
			// 取ってあり、2つ目の課金と待ち時間を積み増すより確実に応答を返す方を採る
			// (キー未設定による降格は予約前の resolveLabelRoute が済ませている)。
			if (route === "gpt-luna" && openaiApiKey) {
				try {
					const gpt = await analyzeLabelWithGptResearch(
						openaiApiKey,
						input.imageDataUrls,
						(t) => ctx.addLogFields({ webResearch: t }),
					);
					extractions.push(gpt.extraction);
					usage = addUsage(usage, gpt.usage);
					ctx.addLogFields({ fieldSources: gpt.fieldSources });
					markExecutedBy("gpt-luna");
				} catch (gptErr) {
					logWarn("label gpt research failed; falling back to Workers AI", {
						userId,
						requestId,
						err: gptErr,
					});
				}
			} else if (route === "web-research" && anthropicApiKey) {
				try {
					const web = await analyzeLabelWithWebResearch(
						anthropicApiKey,
						input.imageDataUrls,
						(t) => ctx.addLogFields({ webResearch: t }),
					);
					extractions.push(web.extraction);
					usage = addUsage(usage, web.usage);
					ctx.addLogFields({ fieldSources: web.fieldSources });
					markExecutedBy("web-research");
				} catch (webErr) {
					logWarn("label web research failed; falling back to Workers AI", {
						userId,
						requestId,
						err: webErr,
					});
				}
			}

			if (extractions.length === 0) {
				// Workers AI 経路: 写真は1枚ずつ解析して抽出結果をマージする(総合判断はマージ側)。
				// 1枚ずつにするのは、複数画像を1リクエストに載せる方式の可否がモデル/環境で
				// 不安定なのを避けるためと、ある1枚の解析失敗(モデルがJSONを返さない等)で
				// 全体を落とさないため。個々の失敗はスキップし、全滅時のみ例外にする。
				let anyCallOk = false;
				let lastPhotoErr: unknown;
				// 高精度経路が失敗して降格した場合、そこまでの usage は**破棄する**。
				// 課金は実行したモデル1つの単価で行う(chargeFor に渡せるモデルは1つ)。
				// 失敗した高精度呼び出しのぶんは原価としては発生しているが、ユーザには
				// 「失敗した推論の料金」を負担させない(過小請求側=ユーザ有利に倒す)。
				usage = {};
				for (const [
					photoIndex,
					imageDataUrl,
				] of input.imageDataUrls.entries()) {
					try {
						const raw = await env.AI.run(AI_LABEL_MODEL, {
							messages: buildLabelMessages(imageDataUrl),
							// JSON Schema準拠の出力を強制する(vLLM系のguided decoding)
							guided_json: LABEL_JSON_SCHEMA,
							max_tokens: AI_LABEL_MAX_OUTPUT_TOKENS,
						});
						// guided_json 時の response は文字列とパース済みオブジェクトの両方がありうる
						// (parseLabelResponse が両対応する)
						const out = raw as {
							response?: unknown;
							usage?: { total_tokens?: number };
						};
						extractions.push(parseLabelResponse(out.response ?? ""));
						// Workers AI は内訳を返さないので全量を出力単価で換算する(保守的)。
						// 写真ごとの usage を足し込むので、欠落した回は 0 として素通しする
						// (全滅時のみ measured.microUsd === 0 で予約見積の床に落ちる)。
						usage = addUsage(usage, toWorkersAiUsage(out.usage) ?? {});
						anyCallOk = true;
					} catch (photoErr) {
						// この1枚は読み取れなかった(モデル失敗/JSON化失敗)。他の写真で続行するが、
						// モデルエラーとJSONパース失敗を後から切り分けられるよう記録は残す(#156)。
						lastPhotoErr = photoErr;
						logWarn("label photo analysis failed", {
							userId,
							requestId,
							photoIndex,
							err: photoErr,
						});
					}
				}
				// 全ての写真で失敗したら「推論失敗」として予約を全額返却する(下の catch へ)。
				// 最後の失敗要因を cause に持たせ、全滅時の原因追跡を可能にする(#156)。
				if (!anyCallOk) {
					throw new Error("すべての写真の解析に失敗しました", {
						cause: lastPhotoErr,
					});
				}
				markExecutedBy("workers-ai");
			}
			const suggestions = buildLabelSuggestions(mergeExtractions(extractions));
			// **実際に結果を出した経路のモデル単価で課金する**。意図した経路(route)で換算すると、
			// Claude が落ちて Workers AI が拾った回に Opus の単価で Llama の推論を課金してしまう。
			const executedRoute = executedBy ?? route;
			const executedModel = AI_LABEL_ROUTE_MODELS[executedRoute];
			const measured = chargeFor(executedModel, usage);
			let charge: CreditCharge;
			if (measured.microUsd > 0) {
				charge = measured;
			} else {
				// 実測が取れなかった回の床は**実行された経路の見積**にする(#404)。予約額
				// (= 意図した経路の見積)を使うと、高精度経路が落ちて Workers AI が拾い、かつ
				// Workers AI が usage を返さなかった回に、Llama 1回の推論へ高精度経路の予約全量
				// (例: 275クレジット)を確定課金してしまう。単価換算(chargeFor)を実行経路に
				// 揃えているのと同じ理由で、フォールバックの床も実行経路に揃える。
				// 実行経路 = 予約した経路なら値は予約額と一致するので、降格が無い回の挙動は変わらない。
				charge = fallbackCharge(
					estimateLabelReserveCharge(executedRoute, input.imageDataUrls.length)
						.microUsd,
				);
				// 実測欠落の頻度を観測できるようにする(Workers AI の usage は任意)。
				logWarn("label usage missing; charging the executed route estimate", {
					userId,
					requestId,
					route,
					executedBy: executedRoute,
					reservedMicroUsd: ctx.reservedMicroUsd,
					chargedMicroUsd: charge.microUsd,
				});
			}
			return { value: suggestions, charge };
		},
	);
	if (result.blocked) {
		return {
			blocked: true,
			balance: result.balance,
			required: result.required,
		};
	}
	return {
		blocked: false,
		suggestions: result.value,
		actualTokens: result.charge.tokens,
		balance: result.balance,
	};
}

export interface AnalyzeWineListInput {
	/**
	 * ワインリスト/棚の写真の data URI(data:image/...;base64,...)の配列。HTTP URL は不可。
	 * 最低1枚・最大 MAX_PHOTOS_PER_IMPORT_BATCH 枚。
	 */
	imageDataUrls: string[];
}

/** レビュー画面のサマリ(「23銘柄を検出(重複3件を統合・既存と2件一致)」)の材料。 */
export interface WineListAnalysisSummary {
	/** 統合後の銘柄数(= candidates.length)。 */
	detected: number;
	/**
	 * 写真群の被写体(単一ワインのエチケット / ワインリスト・棚)。`single_wine` の
	 * とき、UI は一括登録のレビューではなく単体の「ワインを記録」へ案内する(#416)。
	 */
	subject: WineListSubject;
	/** バッチ内の重複統合で畳まれた件数。 */
	mergedDuplicates: number;
	/** 既存セラーの銘柄と一致した件数(新規作成せず目撃記録を足す候補)。 */
	matchedExisting: number;
	/** 列挙しきれなかった銘柄が残っているか。UI は写真を分けての再解析を案内する。 */
	truncated: boolean;
}

export type AnalyzeWineListResult =
	| { blocked: true; balance: number; required: number }
	| {
			blocked: false;
			candidates: WineListCandidate[];
			summary: WineListAnalysisSummary;
			actualTokens: number;
			balance: number;
	  };

/**
 * 一括抽出でユーザに対して**実際に走る経路**。返せる経路が無ければ `null`(#426)。
 *
 * エチケット解析と同じ `preferredLabelEngine` を読み、`resolveWineListRoute` で
 * 一括抽出用に解決する(Workers AI へは降格しない)。UI の必要クレジット表示と
 * `analyzeWineList` の予約が**同じ解決を通る**ようにするための単一の判定口。
 */
export async function resolveWineListRouteForUser(
	userId: string,
): Promise<WineListRoute | null> {
	const { preferredLabelEngine } = await userService.getCurrentUser(userId);
	const engine = toLabelEngineKey(preferredLabelEngine) ?? DEFAULT_LABEL_ENGINE;
	return resolveWineListRoute(engine, labelProviderAvailability());
}

/**
 * 一括抽出が使える環境か(= OPENAI_API_KEY / ANTHROPIC_API_KEY のいずれかが
 * 設定されているか)。
 *
 * **この経路は Workers AI へフォールバックしない**(Issue #358 の決定)ため、
 * どちらのキーも無い環境では機能そのものを出さない。UI の出し分けとサーバ側の拒否が
 * 同じ判定を見るよう、ここを単一の判定口にする。**ユーザ設定には依存しない**
 * (どのエンジンを選んでいても、キーがあるほうの高精度経路に載る)。
 */
export function isWineListAnalysisAvailable(): boolean {
	const availability = labelProviderAvailability();
	return availability.openai || availability.anthropic;
}

/**
 * Claude で全写真を1リクエスト解析し、銘柄配列を取り出す。env 非依存(apiKey を注入)で
 * 失敗は throw する(エチケット解析の高精度経路と同じ契約)。
 *
 * web検索ツールは付けない: 銘柄数 × 検索でコストが発散するため裏取りはしない
 * (裏取りしたい銘柄は登録後に単体のエチケット解析を使う住み分け)。サーバー側
 * ツールループが無いので pause_turn の継続ループも要らない。
 */
async function extractWineListWithClaude(
	apiKey: string,
	imageDataUrls: string[],
): Promise<{ parsed: WineListParseResult; usage: AiUsage }> {
	const client = new Anthropic({ apiKey });
	const response = await client.messages.create({
		model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
		max_tokens: AI_WINE_LIST_MAX_OUTPUT_TOKENS,
		messages: buildWineListMessages(imageDataUrls),
	});
	const usage = toAnthropicUsage(response.usage);
	if (response.stop_reason === "refusal") {
		throw new Error("Claudeがワインリストの解析の応答を拒否しました");
	}
	// 出力上限で打ち切られた応答は JSON が途中で切れており、パースに回すと
	// 「形式が不正」という無関係な例外になる。銘柄が多すぎることが原因だと
	// ユーザが分かる形で返す(escape hatch: 写真を分けて再解析)。
	if (response.stop_reason === "max_tokens") {
		throw new BadRequestError(WINE_LIST_TRUNCATED_ERROR_MESSAGE);
	}
	const parsed = parseWineListResponse(
		joinResponseText(response.content),
		imageDataUrls.length,
	);
	return { parsed, usage };
}

/**
 * GPT(Responses API)で全写真を1リクエスト解析し、銘柄配列を取り出す(#426)。
 * Claude 経路と同じ契約(env 非依存・失敗は throw)で、返す形も揃える。
 *
 * Claude 経路との違い:
 *  - structured outputs(strict)で出力形式を強制する。指示文は共有しているので、
 *    形が保証されるぶんだけ Claude 経路より安全側になる
 *  - web検索ツールは付けない(#358 の住み分け)。エチケット解析の GPT 経路と違い
 *    サーバー側ツールループが無いので、web検索回数の計上も要らない(0件)
 */
async function extractWineListWithGpt(
	apiKey: string,
	imageDataUrls: string[],
): Promise<{ parsed: WineListParseResult; usage: AiUsage }> {
	const client = new OpenAI({ apiKey });
	const response = await client.responses.create({
		model: AI_WINE_LIST_ROUTE_MODELS["gpt-luna"],
		input: buildWineListGptInput(imageDataUrls),
		max_output_tokens: AI_WINE_LIST_MAX_OUTPUT_TOKENS,
		reasoning: { effort: AI_WINE_LIST_GPT_REASONING_EFFORT },
		text: buildWineListGptTextFormat(),
	});
	// web検索を使わない経路なので回数は 0(usage に出ないのは同じだが、数える対象が無い)
	const usage = toGptUsage(response.usage, 0);
	const parsed = parseWineListResponse(
		extractWineListGptText(response),
		imageDataUrls.length,
	);
	return { parsed, usage };
}

/**
 * 複数写真からワインの銘柄を一括抽出し、レビュー画面に出す候補を返す(Issue #358)。
 *
 * distinct は2段階:
 *  1. バッチ内の重複統合(モデルにも指示しているが、その取りこぼしの保険)
 *  2. 既存セラーとの突合(一致したものは新規作成ではなく目撃記録の追加候補にする)
 *
 * クレジットは他のAI経路と同じ 予約 → 実測確定 / 失敗時返却 の骨格。既存セラーの
 * 読み出しは**予約より前**に済ませ、「予約したら必ず try で囲まれている」形を保つ(#245)。
 */
export async function analyzeWineList(
	userId: string,
	input: AnalyzeWineListInput,
): Promise<AnalyzeWineListResult> {
	if (input.imageDataUrls.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	if (input.imageDataUrls.length > MAX_PHOTOS_PER_IMPORT_BATCH) {
		throw new BadRequestError(
			`写真は最大${MAX_PHOTOS_PER_IMPORT_BATCH}枚までです`,
		);
	}
	// 経路の解決(env + ユーザ設定の D1 読み)は**予約より前**に済ませ、「予約したら
	// 必ず try で囲まれている」形を保つ(#245)。
	const route = await resolveWineListRouteForUser(userId);
	if (!route) {
		// UI 側は isWineListAnalysisAvailable で導線ごと隠すので、ここに来るのは
		// 直接APIを叩かれた場合。機能が無効な環境であることを 503 で明示する。
		throw new HttpError(
			503,
			"この環境では写真からの一括登録を利用できません。管理者にお問い合わせください。",
		);
	}
	const apiKey = (
		route === "gpt-luna" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY
	)?.trim();
	// resolveWineListRoute はキーの設定状況から経路を選ぶので、ここが空になるのは
	// 解決とキーの読み出しがズレたときだけ。型を絞るためのガード。
	if (!apiKey) {
		throw new HttpError(
			503,
			"この環境では写真からの一括登録を利用できません。管理者にお問い合わせください。",
		);
	}

	// 既存セラーとの突合材料。D1 読みなので予約より前に済ませる(#245)。
	const { entries } = await drunkWineService.listDrunkWines(userId);
	const estimate = estimateWineListReserveCharge(
		route,
		input.imageDataUrls.length,
	);
	const model = AI_WINE_LIST_ROUTE_MODELS[route];
	const requestId = `scan_list:${crypto.randomUUID()}`;
	const logBase = {
		feature: "wine_list_analysis",
		// 一括抽出はフォールバックを持たない(#358)ので、選択と実行経路は常に一致する。
		selected: route,
		route,
		model,
		photoCount: input.imageDataUrls.length,
	} as const;

	const result = await runMeteredInference(
		userId,
		{ estimate, requestId, logBase },
		async (ctx) => {
			// **フォールバックは持たない**。片方の失敗でもう一方を叩くと、失敗した推論の
			// 原価に加えてもう1回ぶんの消費が乗る(#404 と同種の問題を作らない)。
			const { parsed, usage } =
				route === "gpt-luna"
					? await extractWineListWithGpt(apiKey, input.imageDataUrls)
					: await extractWineListWithClaude(apiKey, input.imageDataUrls);
			const deduped = dedupeWineListItems(parsed.wines);
			const candidates = matchExistingEntries(
				buildWineListCandidates(deduped.items),
				entries,
			);
			const summary: WineListAnalysisSummary = {
				detected: candidates.length,
				subject: parsed.subject,
				mergedDuplicates: deduped.mergedCount,
				matchedExisting: candidates.filter((c) => !!c.existing).length,
				truncated: parsed.truncated,
			};
			// 実測が取れなければ予約全量を実測とみなす。経路はユーザ設定で変わるが
			// **経路間のフォールバックが無い**(#426)ので、予約はこの推論を実行した経路の
			// 見積そのものであり、そのまま「実行された経路の見積」でもある(#404)。
			const measured = chargeFor(model, usage);
			const charge =
				measured.microUsd > 0 ? measured : fallbackCharge(ctx.reservedMicroUsd);
			// フォールバックが無いので実行経路は常に選択経路と一致する。
			ctx.addLogFields({ executedBy: route });
			return { value: { candidates, summary }, charge };
		},
	);
	if (result.blocked) {
		return {
			blocked: true,
			balance: result.balance,
			required: result.required,
		};
	}
	return {
		blocked: false,
		candidates: result.value.candidates,
		summary: result.value.summary,
		actualTokens: result.charge.tokens,
		balance: result.balance,
	};
}
