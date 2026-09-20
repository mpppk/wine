import { env } from "cloudflare:workers";
import { z } from "zod";
import {
	AI_LABEL_AGENT_BUDGET_RATIO,
	AI_LABEL_AGENT_MAX_STEPS,
	AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
	AI_LABEL_GPT_MODEL,
	AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
	AI_LABEL_MAX_OUTPUT_TOKENS,
	AI_LABEL_MODEL,
	AI_LABEL_ROUTE_MODELS,
	AI_LABEL_VIEW_MAX_DIMENSION,
	AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
	AI_LABEL_WEB_MAX_SEARCHES,
	AI_LABEL_WEB_MODEL,
	AI_MAX_OUTPUT_TOKENS,
	AI_REGION_QA_MODELS,
	AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_GPT_SEARCH_CONTEXT_SIZE,
	AI_WINE_LIST_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_MAX_SEARCHES,
	AI_WINE_LIST_ROUTE_MODELS,
	anthropicReasoningForEffort,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REASONING_EFFORT,
	DEFAULT_REGION_QA_MODEL,
	estimateLabelReserveCharge,
	estimateRegionQaReserveCharge,
	estimateWineListReserveCharge,
	type LabelEngineKey,
	type LabelRoute,
	type ReasoningEffortKey,
	type RegionQaModelKey,
	resolveLabelRoute,
	resolveWineListRoute,
	toLabelEngineKeyWithCompat,
	toReasoningEffortKey,
	toRegionQaModelKey,
	type WineListRoute,
} from "#/lib/ai/config";
import { AI_FEATURE_GENERATION_PREFIXES } from "#/lib/ai/inference-log";
import {
	buildAgentLabelPrompt,
	buildKnownGrapesSection,
	buildKnownListsSection,
	buildLabelMessages,
	buildLabelSuggestions,
	buildWebLabelPrompt,
	extractJsonPayload,
	LABEL_JSON_SCHEMA,
	LABEL_WEB_JSON_SCHEMA,
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
} from "#/lib/ai/label-gpt-research";
import {
	type AnswerCollector,
	buildLabelTools,
	SUBMIT_ANSWER_TOOL_NAME,
	ZOOM_OUTPUT_MAX_DIMENSION,
	ZOOM_PHOTO_TOOL_NAME,
} from "#/lib/ai/label-tools";
import { buildWebLabelMessages } from "#/lib/ai/label-web-research";
import {
	LABEL_AGENT_RESEARCH_PROMPT,
	LABEL_WEB_RESEARCH_PROMPT,
	REGION_QA_SYSTEM_PROMPT,
	WINE_LIST_RESEARCH_PROMPT,
} from "#/lib/ai/managed-prompts";
import {
	chatCompletion,
	type OpenRouterChatResult,
	type OpenRouterFunctionTool,
	type OpenRouterMessage,
	type OpenRouterTool,
	type OpenRouterUserContent,
} from "#/lib/ai/openrouter";
import {
	buildRegionChatMessages,
	buildRegionContext,
	type ChatMessage,
	estimateInputTokens,
	type RegionContextInput,
	stripReasoning,
} from "#/lib/ai/region-qa";
import {
	concatWebResearchTraces,
	extractOpenRouterTrace,
	type WebResearchTrace,
} from "#/lib/ai/web-research-trace";
import {
	buildWineListCandidates,
	buildWineListMessages,
	buildWineListPrompt,
	dedupeWineListItems,
	matchExistingEntries,
	parseWineListResponse,
	WINE_LIST_TRUNCATED_ERROR_MESSAGE,
	type WineListCandidate,
	type WineListParseResult,
	type WineListSubject,
} from "#/lib/ai/wine-list-extraction";
import {
	assertWineListChatFinished,
	buildWineListGptInput,
	buildWineListGptTextFormat,
} from "#/lib/ai/wine-list-gpt";
import {
	type AiUsage,
	addUsage,
	type CreditCharge,
	getModelPricing,
	toCharge,
	totalTokens,
	usageToMicroUsd,
} from "#/lib/billing/ai-pricing";
import { BadRequestError, HttpError } from "#/lib/errors";
import {
	createPhotoRedactor,
	describePhotoSummaries,
} from "#/lib/images/photo-redact";
import {
	cropImage,
	downscaleImage,
	isImageTransformAvailable,
} from "#/lib/images/transform";
import { logWarn } from "#/lib/logger";
import type {
	LangfuseGenerationInput,
	LangfuseSpanInput,
} from "#/lib/observability/langfuse";
import {
	getManagedPrompt,
	type ManagedPromptResult,
} from "#/lib/observability/langfuse-prompt";
import { alertOperator } from "#/lib/observability/operator-alert";
import type { DrunkWineEntry } from "#/lib/services/drunk-wine-service";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import {
	type FinishMeteredInferenceResult,
	finishMeteredInference,
	type MeteredInferenceContext,
	type MeteredInferenceLogBase,
	type MeteredInferenceOutput,
	type MeteredInferenceReservation,
	runMeteredInference,
} from "#/lib/services/metered-inference";
import * as userService from "#/lib/services/user-service";
import { getAop, getRegion, getVariety, listAops } from "#/lib/wine/service";

/**
 * 実測 usage を計上量へ畳む**唯一の関門**(#355)。
 *
 * `model` は「意図した経路」ではなく**実際に推論したモデル**を渡すこと。エチケット解析は
 * 経路ごとにモデルが違うので、別の経路のモデルで換算すると単価を取り違える(例: Opus の
 * 単価で Luna の推論を課金してしまう)。
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
 * (地域Q&A・ワインリスト解析)では両者は同じ値なので予約額を渡してよいが、
 * エチケット解析は実行した経路の見積を渡す(降格は無いので route = 実行経路。#602)。
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
// グラウンディング材料を wine サービスから解決し、クレジット予約→(OpenRouter 実行)→
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
 * 地域についての質問に OpenRouter 経由で答え、実測トークンでクレジットを確定消費する。
 * 残高不足なら推論せず blocked を返す(throw しない)。推論失敗時は予約全額を返却して再throw。
 */
export async function answerRegionQuestion(
	userId: string,
	input: AskRegionInput,
): Promise<AskRegionResult> {
	const context = buildContext(input.regionId, input.aopId);
	// system プロンプトは Langfuse が正(#512 Phase 4)。地域情報は変数として注入する。
	// **予約より前**に取る: 予約の後・try の外で await すると、その throw が下の
	// catch(refundReservationOnFailure)へ届かない(モデル解決を先に済ませるのと同じ理由)。
	// `getManagedPrompt` は throw しない設計だが、順序の意味はここに残す。
	const managedPrompt = await getManagedPrompt(REGION_QA_SYSTEM_PROMPT, {
		region_context: buildRegionContext(context),
	});
	const messages = buildRegionChatMessages({
		system: managedPrompt.text,
		history: input.history ?? [],
		question: input.question,
	});
	// 見積は組み上がったメッセージの実長から出るので、Langfuse 側でプロンプトが
	// 伸び縮みしても予約が自動で追随する。
	const promptTokens = estimateInputTokens(messages);
	const requestId = `ask_region:${crypto.randomUUID()}`;

	// プロフィール設定(または明示指定)→ 実モデルID＋固有オプションに解決。
	// **予約より前**に解決する(#245)。明示指定が無ければ D1 を読むため、一時エラーや
	// NotFoundError で throw しうる。予約の後・try の外でこれを await すると、その throw が
	// 下の catch(refundReservationOnFailure)に届かず、予約が返却も記録もされずに消える。
	// モデル解決は予約と独立なので、先に済ませて「予約したら必ず try で囲まれている」形にする。
	const modelKey = await resolveModelKey(userId, input.model);
	const model = AI_REGION_QA_MODELS[modelKey];
	// 接続キーは**予約より前**に解決する(#245)。未設定なら予約せず利用不可として
	// 返す(別モデルへの自動フォールバックはしない。#602)。
	const apiKey = openRouterApiKey();
	if (!apiKey) {
		throw new HttpError(503, OPENROUTER_UNAVAILABLE_MESSAGE);
	}
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
			const response = await chatCompletion(apiKey, {
				model: model.id,
				messages,
				maxTokens: AI_MAX_OUTPUT_TOKENS,
				// モデル固有の推論設定。Gemma 4 は既定で thinking が有効で、放置すると
				// reasoning が出力枠(512)を先に使い切り本文が途中で切れる/空になるため
				// effort "none" で無効化する(Llama 4 はこの指定を持たない)。
				...(model.reasoning ? { reasoning: model.reasoning } : {}),
			});
			// thinking 無効化済みだが、reasoning モデルへ差し替えても <think>…</think> を表示に出さない
			const answer = stripReasoning(response.text).trim();
			// OpenRouter は入出力の内訳(prompt/completion + キャッシュ読み)を返す。
			// 実測が空(すべて 0)の回は予約全量を実測とみなす —— **この機能は単経路で
			// 降格が無い**ので、予約額はそのまま「実行された経路の見積」でもある
			// (#404 のエチケット解析とは違う)。
			const measured = response.usage;
			const isEmpty =
				(measured.inputTokens ?? 0) === 0 &&
				(measured.outputTokens ?? 0) === 0 &&
				(measured.cacheReadTokens ?? 0) === 0;
			const charge = isEmpty
				? fallbackCharge(ctx.reservedMicroUsd)
				: chargeFor(model.id, measured);
			// 単経路なので実行経路は選択経路と常に一致する。
			ctx.addLogFields({ executedBy: modelKey });
			ctx.recordGeneration({
				name: `region_qa:${model.id}`,
				model: model.id,
				input: messages,
				output: answer,
				// どの版で答えたかを残す。fallback で動いた回は ref が null になり
				// prompt 属性が載らないので、版ごとの指標が汚れない。
				...(managedPrompt.ref ? { prompt: managedPrompt.ref } : {}),
				metadata: { promptSource: managedPrompt.source },
				usage: measured
					? {
							inputTokens: measured.inputTokens,
							outputTokens: measured.outputTokens,
							totalTokens: totalTokens(measured),
						}
					: undefined,
			});
			// OpenRouter は内訳を返すが、usage が無い回は空。web検索も使わないので
			// `webSearches` は載らない——「検索できたのにしなかった 0」とは意味が違う。
			return { value: answer, charge, usage: measured ?? {} };
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
 * OpenRouter の接続が無い環境で返す利用不可メッセージ。キー未設定は推論・予約の
 * 前に検知し、予約せずこの 503 で返す(別モデルへの自動フォールバックはしない。#602)。
 */
export const OPENROUTER_UNAVAILABLE_MESSAGE =
	"この環境ではAI機能を利用できません。管理者にお問い合わせください。";

/**
 * このユーザのエチケット解析で**実際に走る経路**を返す。OpenRouter の接続が無い
 * 環境では `null`(利用不可)。
 *
 * 解析前に必要クレジットを出すために UI が要る情報だが、経路はシークレットの設定状況
 * (`OPENROUTER_API_KEY`)に依存するのでクライアントでは決められない。
 * 判定は resolveLabelPlan と**同じ resolveLabelRoute** を通すので、表示とサーバの
 * 予約が食い違わない(経路ごとに条件を書き分けるとドリフトする。#354 の教訓)。
 */
export async function resolveLabelRouteForUser(
	userId: string,
): Promise<LabelRoute | null> {
	return (await resolveLabelEngineAndRoute(userId)).route;
}

/**
 * ユーザ設定(D1読み)+ env から「選択エンジン」と「実行経路」を解決する。
 * **経路の解決口はここ1つ**にする——表示用(resolveLabelRouteForUser)と予約用
 * (resolveLabelPlan)で別々に書くと、片方だけがユーザ設定を読み忘れる形でドリフトする
 * (#354 の教訓)。推論の深さも同じ D1 行から読むのでここで一緒に解決する。
 */
async function resolveLabelEngineAndRoute(userId: string): Promise<{
	engine: LabelEngineKey;
	route: LabelRoute | null;
	effort: ReasoningEffortKey;
}> {
	const { preferredLabelEngine, preferredReasoningEffort } =
		await userService.getCurrentUser(userId);
	// 書き込み側(auth.ts の validator)と同じ許可リストで照合する。旧データ・不正値は
	// 既定(高精度・low)へフォールバックする(resolveModelKey と同じ流儀)。旧
	// `workers-ai` 値は `standard` へ読み替える(#602 の移行対応表)。
	const engine =
		toLabelEngineKeyWithCompat(preferredLabelEngine) ?? DEFAULT_LABEL_ENGINE;
	return {
		engine,
		route: resolveLabelRoute(engine, labelProviderAvailability()),
		effort:
			toReasoningEffortKey(preferredReasoningEffort) ??
			DEFAULT_REASONING_EFFORT,
	};
}

/** OpenRouter 接続が使える環境か(全AI機能の単一の判定口)。 */
export function labelProviderAvailability(): {
	openrouter: boolean;
} {
	return {
		openrouter: openRouterApiKey() !== undefined,
	};
}

/**
 * OpenRouter のプロバイダキー(env から読む)。**予約より前に読むこと**(#245)。
 *
 * ジョブ経路のコンシューマも同じ関数を通す。キー**そのもの**はジョブ行に持たない
 * (シークレットを D1 へ書かない)。経路は投入時に確定させて持ち回るので、ここで
 * 読むのは「その経路を実行するための鍵」だけになる。
 */
export function openRouterApiKey(): string | undefined {
	return env.OPENROUTER_API_KEY?.trim() || undefined;
}

/** 高精度経路が返す、抽出結果と観測情報。 */
interface LabelResearchResult {
	extraction: LabelExtraction;
	usage: AiUsage;
	/** モデルが自己申告したフィールドごとの根拠。書かれていなければ undefined。 */
	fieldSources?: LabelFieldSources;
	/**
	 * こちらの検証器を通った回答か(エージェントループ経路のみ)。`false` は
	 * 「予算・ステップ上限で打ち切り、未検証の回答を候補として返した」ことを意味する。
	 * **実行記録に載せて収束率を観測する**ための情報で、利用者への出し分けはしない。
	 */
	verified?: boolean;
	/** ループのステップ数(エージェントループ経路のみ)。収束の速さの観測用。 */
	steps?: number;
}

/**
 * 検索の軌跡の受け取り口。**戻り値ではなくコールバックで渡す**のは、応答のパースに
 * 失敗した回(= フォールバックする回)こそ「何を検索したか」を知りたいため。
 * 実装は応答を受け取り次第、パースより先にこれを呼ぶ。
 */
type WebResearchTraceSink = (trace: WebResearchTrace) => void;

/**
 * Langfuse への報告口(#514/#515)。`MeteredInferenceContext` の recordGeneration /
 * recordSpan をそのまま差す。**ai-service は `startObservation` を直書きしない**
 * (唯一の入口は `src/lib/observability/langfuse.ts`。#166/#174 と同じ失敗の形を避ける)。
 * エチケット解析(#514)と一括抽出(#515)の両経路で使う。
 */
interface InferenceObserver {
	recordGeneration(input: LangfuseGenerationInput): void;
	recordSpan(input: LangfuseSpanInput): void;
}

/**
 * Langfuse 管理下のプロンプトの解決結果。**本文 + 版の追跡情報**を束ねる。
 *
 * `getManagedPrompt` は取得に失敗してもコードの fallback 本文を返すので、
 * 呼び出し側は成功/失敗を区別せず `text` をそのままモデルへ渡せる。
 * 版の追跡(`ref` / `source`)は generation の `prompt` / `metadata.promptSource`
 * に載せ、Langfuse 上で世代を追えるようにする(#512 Phase 4 / IMPL-3 W3-2)。
 */
interface ResolvedPrompt {
	/** 変数を埋め終わった本文。モデルへ渡すのはこれ。 */
	text: string;
	/** 取得した版へのリンク。fallback の回は null。 */
	ref: ManagedPromptResult["ref"];
	/** どこから来た本文か。fallback の理由まで残る。 */
	source: ManagedPromptResult["source"];
}

function toResolvedPrompt(result: ManagedPromptResult): ResolvedPrompt {
	return { text: result.text, ref: result.ref, source: result.source };
}

/**
 * 世代の追跡情報を全 generation に載せる包み。`withSpan` でも `startObservation`
 * でもなく、既存の `recordGeneration` へ `prompt` / `metadata.promptSource` を
 * 足すだけ——計装の入口は `finishMeteredInference` のまま。
 */
function withPromptAttribution(
	obs: InferenceObserver,
	prompt: ResolvedPrompt | undefined,
): InferenceObserver {
	if (!prompt) return obs;
	return {
		recordGeneration: (input) =>
			obs.recordGeneration({
				...input,
				...(prompt.ref ? { prompt: prompt.ref } : {}),
				metadata: { ...(input.metadata ?? {}), promptSource: prompt.source },
			}),
		recordSpan: (input) => obs.recordSpan(input),
	};
}

/**
 * エチケット解析の高精度プロンプトを Langfuse 管理下から引く。**throw しない**
 * (`getManagedPrompt` が fallback へ落とす)ので、予約の前後どちらに置いても
 * 予約を漏らさない。取得は推論の実行直前(ジョブのコンシューマ)で行い、
 * 予約時の見積には影響させない。
 */
async function resolveLabelResearchPrompt(
	route: LabelRoute,
): Promise<{ web?: ResolvedPrompt; agent?: ResolvedPrompt }> {
	if (route === "gpt-luna") {
		return {
			agent: toResolvedPrompt(
				await getManagedPrompt(LABEL_AGENT_RESEARCH_PROMPT, {
					known_grapes: buildKnownGrapesSection(),
				}),
			),
		};
	}
	if (route === "web-research") {
		return {
			web: toResolvedPrompt(
				await getManagedPrompt(LABEL_WEB_RESEARCH_PROMPT, {
					known_lists: buildKnownListsSection(),
				}),
			),
		};
	}
	return {};
}

/** 一括抽出のプロンプトを Langfuse 管理下から引く(同上・throw しない)。 */
async function resolveWineListResearchPrompt(
	photoCount: number,
): Promise<ResolvedPrompt> {
	return toResolvedPrompt(
		await getManagedPrompt(WINE_LIST_RESEARCH_PROMPT, {
			known_lists: buildKnownListsSection(),
			photo_count: String(photoCount),
		}),
	);
}

/**
 * OpenRouter の応答(本文 + function ツール呼び出し)を、Langfuse に載せてよい形へ畳む。
 * テキストとツール呼び出し(名前と引数)は残す。引数にバイナリは入らない
 * (zoom_photo の結果は画像パートとして別途メッセージに載り、ここには座標だけが残る)。
 * 写真の方針(docs/deployment.md)の裏返しで、モデル応答側にも同じ規律を適用する。
 */
function toSafeToolCalls(
	toolCalls: OpenRouterChatResult["toolCalls"],
): unknown {
	return toolCalls.map((call) => ({
		name: call.name,
		arguments: call.arguments,
	}));
}

/**
 * 高精度経路: Claude(マルチモーダル + サーバーサイドweb検索)で全写真を1リクエスト
 * 解析し、生産者公式サイト・ワインDBでの裏取り込みの抽出結果を返す。
 * env 非依存(apiKey を注入)で、失敗は throw する。
 *
 * #602 で Anthropic SDK 直接接続から OpenRouter 経由へ移した。web検索は
 * `openrouter:web_search` サーバーツール(engine native → Anthropic ネイティブ検索)
 * で、1リクエストの中で完結する。pause_turn の継続ループは要らない
 * (回数上限は max_uses が Anthropic へ転送される)。使用回数は応答の
 * `usage.server_tool_use.web_search_requests` に出る。
 */
async function analyzeLabelWithWebResearch(
	apiKey: string,
	imageDataUrls: string[],
	onTrace: WebResearchTraceSink,
	obs?: InferenceObserver,
	/** Langfuse 管理下から引いた本文。省略時はコードの版を使う。 */
	promptText?: string,
	/** ユーザ設定の推論の深さ。low は reasoning 無指定(現行どおり)。 */
	effort: ReasoningEffortKey = DEFAULT_REASONING_EFFORT,
): Promise<LabelResearchResult> {
	const messages = buildWebLabelMessages(
		imageDataUrls,
		promptText ?? buildWebLabelPrompt(),
	);
	// Langfuse へ送る入力は**写真を要約へ置き換えた版**(#514)。ハッシュ計算の非同期は
	// ここで済ませてあるので、以降の置き換えは同期で済む。
	const redact = await createPhotoRedactor(imageDataUrls);
	// 写真インベントリはメタデータとして送る(入力が切り詰められても生きる)。
	const photoSummaries = await describePhotoSummaries(imageDataUrls);
	const response = await chatCompletion(apiKey, {
		model: AI_LABEL_WEB_MODEL,
		messages,
		maxTokens: AI_LABEL_WEB_MAX_OUTPUT_TOKENS,
		reasoning: anthropicReasoningForEffort(effort),
		tools: [
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "native",
					max_uses: AI_LABEL_WEB_MAX_SEARCHES,
				},
			},
		],
	});
	const usage = response.usage;
	const trace = extractOpenRouterTrace(response.annotations);
	onTrace(trace);
	if (obs) {
		obs.recordGeneration({
			name: "label_analysis:web-research#1",
			model: AI_LABEL_WEB_MODEL,
			input: redact([...messages]),
			output: response.text,
			metadata: { photos: photoSummaries },
			usage: {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: totalTokens(usage),
			},
		});
		if (trace.steps.length > 0) {
			obs.recordSpan({
				name: "web_search",
				input: trace.steps.map((s) => ({ action: s.action, query: s.query })),
				output: trace.steps,
			});
		}
	}
	// セーフティ分類器が応答を拒否すると本文が空/不完全になる。通常の失敗として扱う。
	if (response.finishReason === "content_filter" || !response.text.trim()) {
		throw new Error("Claudeがエチケット解析の応答を拒否しました");
	}
	assertGptLabelFinished(response.finishReason);
	const payload = extractJsonPayload(response.text);
	return {
		extraction: parseLabelResponse(payload),
		usage,
		// Claude は structured outputs を使えないので sources はプロンプトでしか要求できない。
		// 書かれていなければ undefined になる(パース側が欠落に耐える)。
		fieldSources: parseLabelSources(payload),
	};
}

/**
 * 高精度経路: GPT-5.6 Luna を**エージェントループ**で回し、全写真を総合解析する。
 * Claude経路と同じ契約(env 非依存・失敗は throw)で、返す形も揃える。
 *
 * #602 で OpenAI 直結 + AI SDK から OpenRouter の chat completions へ移した。
 * ループ自体はアプリ側で回し、function ツールの実行だけを行う。web検索は
 * `openrouter:web_search` サーバーツールとして OpenRouter 側で実行される
 * (使用回数は各応答の usage に出る)。
 *
 * **1回で答えを出させない**のがこの経路の要点(#455)。同一写真の解析を4回繰り返すと
 * 毎回別の生産者を返し、そのすべてが `origin: "photo_and_web"` と参照URLを伴っていた。
 * 誤答が裏取り済みの体裁で出てくる以上、モデルの自己申告は停止条件に使えない。
 * 代わりに `submit_answer` の中で**こちらの検証器**を走らせ、通らなければ問題点を
 * ツール結果として返して調べ直させる(label-tools.ts / label-verify.ts)。
 *
 * ループを止めるのは次の3つ。**答えが出たかどうかだけに任せない**:
 *  1. 検証を通った回答が提出された(正常な収束)
 *  2. 原価が予約の `AI_LABEL_AGENT_BUDGET_RATIO` に達した(予約を超えた消費は
 *     settle が頭打ちにするため、超過ぶんは原価の持ち出しになる)
 *  3. ステップ上限(予算計算が壊れても無限には回らないための歯止め)
 */
async function analyzeLabelWithGptResearch(
	apiKey: string,
	/** モデルへ最初に見せる版(縮小済み)。 */
	imageDataUrls: string[],
	/**
	 * 拡大の元になる版(クライアントが送ってきた解像度のまま)。`zoom_photo` はこちらを切る。
	 * 添字は `imageDataUrls` と対応する。**`undefined` なら `zoom_photo` を出さない**
	 * (画像変換が使えない環境)。
	 */
	sourceDataUrls: string[] | undefined,
	onTrace: WebResearchTraceSink,
	budgetMicroUsd: number,
	obs?: InferenceObserver,
	/** Langfuse 管理下から引いた本文。省略時はコードの版を使う。 */
	promptText?: string,
	/** ユーザ設定の推論の深さ。 */
	effort: ReasoningEffortKey = DEFAULT_REASONING_EFFORT,
): Promise<LabelResearchResult> {
	// 軌跡は**モデル呼び出しが終わった時点**で積む。web検索はサーバーツールなので、
	// その実行結果は同じ応答のアノテーションに載ってくる。提出の検証に間に合わせる
	// ため、ツール実行の前に応答内容ごと軌跡へ畳む。
	let trace: WebResearchTrace = { steps: [], stepCount: 0, hosts: [] };
	const collector: AnswerCollector = {};
	// ツール定義は label-tools.ts の SSOT をそのまま使う。実行関数(execute)は
	// AI SDK の形だが、引数だけで呼べる(検証・収集・観測の閉じ込めはそのまま)。
	const labelTools = buildLabelTools({
		collector,
		getVerifyContext: () => ({ trace }),
		photoCount: imageDataUrls.length,
		// **写真の拡大はこの経路の精度の要**(全体写真では読めない文字がある)。
		// 元になるのは縮小前の版で、切り出した結果はモデルへ画像として返る。
		// 画像変換が使えない環境では渡さない = ツールごと出さない。
		...(sourceDataUrls
			? {
					cropPhoto: async (photoIndex, box) => {
						const source = sourceDataUrls[photoIndex];
						if (!source) throw new Error(`写真 ${photoIndex} がありません`);
						const cropped = await cropImage(
							source,
							box,
							ZOOM_OUTPUT_MAX_DIMENSION,
						);
						return { dataUrl: cropped.dataUrl, applied: cropped.applied };
					},
				}
			: {}),
		// ツール実行を span として報告する(#514)。`submit_answer` の検証結果
		// (problems)は「どのステップで何を考えて収束しなかったか」の切り分けに
		// 直結する。失敗した呼び出しは ERROR にして目立たせる。
		...(obs
			? {
					observe: (event: {
						tool: string;
						input: unknown;
						result?: unknown;
						error?: string;
					}) =>
						obs.recordSpan({
							name: event.tool,
							input: event.input,
							output: event.result ?? event.error,
							...(event.error
								? { level: "ERROR" as const, statusMessage: event.error }
								: {}),
						}),
				}
			: {}),
	});
	const functionTools: OpenRouterFunctionTool[] = Object.entries(
		labelTools,
	).map(([name, tool]) => ({
		type: "function",
		function: {
			name,
			// AI SDK の description は関数でも持てるが、OpenRouter へ送るのは文字列だけ。
			description:
				typeof tool.description === "string" ? tool.description : undefined,
			// submit_answer のスキーマは LABEL_WEB_JSON_SCHEMA が正本。AI SDK の
			// jsonSchema ラッパーではなく正本をそのまま渡す。
			parameters:
				name === SUBMIT_ANSWER_TOOL_NAME
					? (LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>)
					: (z.toJSONSchema(tool.inputSchema as z.ZodType) as unknown as Record<
							string,
							unknown
						>),
		},
	}));
	// Langfuse への報告(#514)。**報告点はモデル呼び出しの直後**——ここなら
	// パースや finishReason 検査で失敗する回にも、失敗前のモデルが何を返していたかが
	// 残る(この Phase の主眼)。ハッシュ計算の非同期はループ前に済ませてあるので、
	// 報告の中は同期で済む。
	const redact = await createPhotoRedactor(imageDataUrls);
	// 写真インベントリはメタデータとして送る(入力が切り詰められても生きる)。
	const photoSummaries = await describePhotoSummaries(imageDataUrls);
	const initialMessages = buildGptLabelMessages(
		imageDataUrls,
		promptText ?? buildAgentLabelPrompt(),
	);
	const messages: OpenRouterMessage[] = [...initialMessages];
	const tools: OpenRouterTool[] = [
		{
			type: "openrouter:web_search",
			parameters: {
				engine: "native",
				search_context_size: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			},
		},
		...functionTools,
	];
	let usage: AiUsage = {};
	let steps = 0;
	let reportedSearchSteps = 0;
	for (let step = 0; step < AI_LABEL_AGENT_MAX_STEPS; step++) {
		// 予約に対する原価の上限。次のステップを始める前にしか判定できないので、
		// 比率には余裕を持たせてある(config の AI_LABEL_AGENT_BUDGET_RATIO)。
		if (usageToMicroUsd(AI_LABEL_GPT_MODEL, usage) >= budgetMicroUsd) break;
		const response = await chatCompletion(apiKey, {
			model: AI_LABEL_GPT_MODEL,
			messages,
			tools,
			maxTokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
			reasoning: { effort },
		});
		steps += 1;
		// 内訳ごとに加算する(合算スカラーだと入力・出力・web検索回数が混ざって
		// 原価を復元できない)。
		usage = addUsage(usage, response.usage);
		trace = concatWebResearchTraces([
			trace,
			extractOpenRouterTrace(response.annotations),
		]);
		onTrace(trace);
		if (obs) {
			// モデル呼び出し1回 = generation 1件(#514)。usage は**この呼び出しぶん**。
			obs.recordGeneration({
				name: `label_analysis:gpt-luna#${steps}`,
				model: AI_LABEL_GPT_MODEL,
				// 入力は最初の呼び出しだけ(以降は蓄積した会話で、応答の連なりから読める)。
				input: steps === 1 ? redact(initialMessages) : { step: steps },
				output: {
					text: response.text,
					toolCalls: toSafeToolCalls(response.toolCalls),
				},
				metadata: { photos: photoSummaries, step: steps },
				usage: {
					inputTokens: response.usage.inputTokens,
					outputTokens: response.usage.outputTokens,
					totalTokens: totalTokens(response.usage),
				},
			});
			// web検索はサーバーツールなので span の取り得ない代わりに、
			// **この呼び出しで新しく走った分**を1本の span に畳んで出す。
			const newSteps = trace.steps.slice(
				Math.min(reportedSearchSteps, trace.steps.length),
			);
			reportedSearchSteps = trace.steps.length;
			if (newSteps.length > 0) {
				obs.recordSpan({
					name: "web_search",
					input: newSteps.map((s) => ({ action: s.action, query: s.query })),
					output: newSteps,
				});
			}
		}
		assertGptLabelFinished(response.finishReason);
		if (response.toolCalls.length === 0) break;
		// function 呼び出しを実行し、結果を会話へ載せて次へ回す。サーバーツールは
		// OpenRouter 側で実行済みなのでここには現れない。
		messages.push({
			role: "assistant",
			content: response.text || null,
			tool_calls: response.toolCalls,
		});
		for (const call of response.toolCalls) {
			const tool = (
				labelTools as Record<
					string,
					(typeof labelTools)[keyof typeof labelTools] | undefined
				>
			)[call.name];
			if (!tool) {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: `未知のツール ${call.name} は使えません`,
				});
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(call.arguments);
			} catch {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: "引数のJSONを解釈できませんでした",
				});
				continue;
			}
			try {
				const output = await (
					tool.execute as unknown as (args: unknown) => Promise<unknown>
				)(parsed);
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: toToolResultContent(call.name, output),
				});
			} catch (e) {
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: e instanceof Error ? e.message : String(e),
				});
			}
		}
		// 検証を通った回答が出たら、それ以上考えさせない。
		if (collector.accepted !== undefined) break;
	}

	// 検証を通った回答を最優先。無ければ**検証を通らなかった最後の回答**を使う。
	// これはフォームの自動入力候補であって確定値ではないので、「不完全でも候補を出す」
	// ほうが「解析失敗」より利用者の得になる(利用者が画面で直せる)。どちらも無ければ
	// 推論失敗として throw する。
	const answer = collector.accepted ?? collector.last;
	if (!answer) {
		throw new Error("エージェントループが回答を提出しませんでした");
	}
	return {
		extraction: answer.extraction,
		usage,
		...(answer.fieldSources ? { fieldSources: answer.fieldSources } : {}),
		verified: answer.verified,
		steps,
	};
}

/**
 * function ツールの実行結果をモデルへ返す形へ畳む。`zoom_photo` だけは切り出し画像を
 * 画像パートとして載せる(座標だけ返しても読めるようにはならない)。それ以外は JSON
 * テキストで返す。Langfuse には載せない経路なので、ここでの写真の扱いは会話用。
 */
function toToolResultContent(
	toolName: string,
	output: unknown,
): string | OpenRouterUserContent {
	if (toolName !== ZOOM_PHOTO_TOOL_NAME) {
		return JSON.stringify(output);
	}
	const result = output as {
		error?: string;
		applied?: unknown;
		dataUrl?: string;
	};
	if (result.error || !result.dataUrl) {
		return result.error ?? "拡大に失敗しました";
	}
	return [
		{ type: "text", text: `適用した範囲: ${JSON.stringify(result.applied)}` },
		{ type: "image_url", image_url: { url: result.dataUrl } },
	];
}

/**
 * 予約より前に決めておくものの全部(#460)。
 *
 * 経路・見積・requestId・実行記録の静的部分は、どれも**予約が立つ前に確定していなければ
 * ならない**(#245)。同期経路とジョブ経路でここを別々に書き下ろすと、片方だけが
 * ユーザ設定を読み忘れる/別の見積で予約する、という形でドリフトする。
 *
 * ジョブ経路は `route` / `engine` / `effort` を D1 に永続化し、コンシューマ側では**経路を再解決しない**
 * (予約はこの経路・effortの見積で立っているので、再解決した結果が違えば予約と実行が食い違う)。
 */
export interface LabelPlan {
	/** ユーザがプロフィールで選んでいたエンジン。実行記録の `selected` */
	engine: LabelEngineKey;
	/** 実際に走らせる経路。キーの設定状況で降格しうる */
	route: LabelRoute;
	/** ユーザがプロフィールで選んでいた推論の深さ。ジョブ行に永続化し、コンシューマは再解決しない */
	effort: ReasoningEffortKey;
	/** この経路・枚数での予約見積 */
	estimate: CreditCharge;
	/** 台帳の冪等キー */
	requestId: string;
	/** 全ての結末に載る静的な実行メタデータ */
	logBase: MeteredInferenceLogBase;
	photoCount: number;
}

/** 経路と枚数から、全ての結末に載る静的な実行メタデータを組む。 */
function buildLabelLogBase(options: {
	engine: LabelEngineKey;
	route: LabelRoute;
	effort: ReasoningEffortKey;
	photoCount: number;
}): MeteredInferenceLogBase {
	return {
		feature: "label_analysis",
		selected: options.engine,
		route: options.route,
		effort: options.effort,
		photoCount: options.photoCount,
	};
}

/**
 * エチケット解析の経路・見積・requestId を解決する。**予約より前に呼ぶ**(#245)。
 *
 * OpenRouter の接続が無い環境は 503——別モデルへの自動フォールバックはしない(#602)。
 * env・ユーザ設定(D1読み)の解決をここに閉じ込めることで、呼び出し側は
 * 「plan を作る → 予約する」の順に並べるだけでよくなる。
 */
export async function resolveLabelPlan(
	userId: string,
	photoCount: number,
): Promise<LabelPlan> {
	const { engine, route, effort } = await resolveLabelEngineAndRoute(userId);
	if (!route) {
		throw new HttpError(503, OPENROUTER_UNAVAILABLE_MESSAGE);
	}
	// 見積は経路で大きく違う。経路 → 見積の対応は config.ts に寄せてあり、
	// クライアントの必要クレジット表示も同じ関数を通る。effort は出力見積の倍率に効く。
	return {
		engine,
		route,
		effort,
		estimate: estimateLabelReserveCharge(route, photoCount, effort),
		requestId: `analyze_label:${crypto.randomUUID()}`,
		logBase: buildLabelLogBase({ engine, route, effort, photoCount }),
		photoCount,
	};
}

/**
 * 保存済みのジョブから plan を復元する(#460)。**経路・effortは再解決しない**——予約は投入時の
 * 経路・effortの見積で立っているため、コンシューマ側で解決し直すと(その間に設定が
 * 変わっていた等で)予約と実行が食い違う。
 */
export function restoreLabelPlan(saved: {
	engine: LabelEngineKey;
	route: LabelRoute;
	effort: ReasoningEffortKey;
	photoCount: number;
	requestId: string;
}): LabelPlan {
	return {
		engine: saved.engine,
		route: saved.route,
		effort: saved.effort,
		estimate: estimateLabelReserveCharge(
			saved.route,
			saved.photoCount,
			saved.effort,
		),
		requestId: saved.requestId,
		logBase: buildLabelLogBase(saved),
		photoCount: saved.photoCount,
	};
}

/**
 * エチケット解析の**推論本体**(#460)。同期経路(analyzeWineLabel)とジョブ経路
 * (label-job-service)が共有する。
 *
 * この関数は「予約が既に立っていて、ここでの throw は必ず返却に届く」ことを前提にする
 * (`runMeteredInference` / `finishMeteredInference` の infer として呼ばれる)。
 * **D1 読み・env 解決はここに書かない**——書くと予約後の await が増え、#245 の順序制約が
 * 経路ごとに崩れる余地を作る。必要な材料は plan と引数で渡し切る。
 */
async function runLabelInference(
	userId: string,
	input: {
		imageDataUrls: string[];
		plan: LabelPlan;
		openRouterApiKey: string;
		/**
		 * Langfuse 管理下から引いた高精度プロンプト。**呼び出し側
		 * (`runLabelAnalysisForJob`)が推論の実行直前に解決して渡す**——ここで
		 * 引くと予約後の await が増える(#245)。省略時はコードの版を使う。
		 */
		prompts?: { web?: ResolvedPrompt; agent?: ResolvedPrompt };
	},
	ctx: MeteredInferenceContext,
): Promise<MeteredInferenceOutput<LabelSuggestions>> {
	const { imageDataUrls, plan, openRouterApiKey } = input;
	const { route, requestId } = plan;
	// 実行経路は plan で確定済みで、降格は無い(#602)。実行記録には選択と実行の
	// 両方を載せる(旧フォールバック時代の `executedBy` と同じ見方で読めるよう)。
	ctx.addLogFields({
		executedBy: route,
		model: AI_LABEL_ROUTE_MODELS[route],
	});
	// 裏取りの観測情報(webResearch / fieldSources)は**判明した時点で** ctx に積む。
	// ラッパーが ok と failed の両方の実行記録に載せるので、推論そのものが失敗した回にも
	// 残る —— 「検索まで到達したが結果を使えなかった」ことが分かるのはここだけ(#392)。
	let usage: AiUsage = {};
	const extractions: LabelExtraction[] = [];
	// Langfuse への報告口(#514)。キー未設定なら ctx 側が no-op するので、
	// ここは常に定義してよい。経路ごとの計装はこの口だけを通る。
	const obs: InferenceObserver = {
		recordGeneration: (input) => ctx.recordGeneration(input),
		recordSpan: (input) => ctx.recordSpan(input),
	};

	// 経路ごとの推論は1回ずつ。**失敗しても他の経路へフォールバックしない**
	// (#602。予約は選んだ経路の見積で取ってあり、2つ目の課金と待ち時間を積み増さない)。
	// 世代の追跡は実行した経路の解決結果で付ける。
	if (route === "gpt-luna") {
		const researchObs = withPromptAttribution(obs, input.prompts?.agent);
		// **見せる版と切る版を分ける**。クライアントは拡大に耐える解像度で
		// 送ってくるが、それをそのまま会話へ載せると入力トークンが毎ターン
		// 効いてくる(しかも全体写真は解像度を上げても読めるようにならない
		// ことが実測で分かっている)。会話には縮小版を載せ、`zoom_photo` は
		// 元の版から切る。
		// 画像変換が使えない環境では拡大を諦めて解析だけ通す。設定漏れで
		// 機能が丸ごと落ちるより、精度が下がるだけで済むほうが被害が小さい。
		const canTransform = isImageTransformAvailable();
		if (!canTransform) {
			logWarn("image transform unavailable; zoom_photo disabled", {
				userId,
				requestId,
			});
		}
		const viewDataUrls = canTransform
			? await Promise.all(
					imageDataUrls.map((url) =>
						downscaleImage(url, AI_LABEL_VIEW_MAX_DIMENSION),
					),
				)
			: imageDataUrls;
		const gpt = await analyzeLabelWithGptResearch(
			openRouterApiKey,
			viewDataUrls,
			canTransform ? imageDataUrls : undefined,
			(t) => ctx.addLogFields({ webResearch: t }),
			ctx.reservedMicroUsd * AI_LABEL_AGENT_BUDGET_RATIO,
			researchObs,
			input.prompts?.agent?.text,
			plan.effort,
		);
		extractions.push(gpt.extraction);
		usage = addUsage(usage, gpt.usage);
		ctx.addLogFields({
			fieldSources: gpt.fieldSources,
			verified: gpt.verified,
			steps: gpt.steps,
		});
	} else if (route === "web-research") {
		const researchObs = withPromptAttribution(obs, input.prompts?.web);
		const web = await analyzeLabelWithWebResearch(
			openRouterApiKey,
			imageDataUrls,
			(t) => ctx.addLogFields({ webResearch: t }),
			researchObs,
			input.prompts?.web?.text,
			plan.effort,
		);
		extractions.push(web.extraction);
		usage = addUsage(usage, web.usage);
		ctx.addLogFields({ fieldSources: web.fieldSources });
	} else {
		// 標準経路: 写真は1枚ずつ解析して抽出結果をマージする(総合判断はマージ側)。
		// 1枚ずつにするのは、ある1枚の解析失敗(モデルがJSONを返さない等)で
		// 全体を落とさないため。個々の失敗はスキップし、全滅時のみ例外にする。
		let anyCallOk = false;
		let lastPhotoErr: unknown;
		// Langfuse へ送る入力の写真を要約へ置き換える写像(#514)。
		const redact = await createPhotoRedactor(imageDataUrls);
		// 写真インベントリはメタデータとして送る(入力が切り詰められても生きる)。
		const photoSummaries = await describePhotoSummaries(imageDataUrls);
		for (const [photoIndex, imageDataUrl] of imageDataUrls.entries()) {
			try {
				const message = buildLabelMessages(imageDataUrl);
				const response = await chatCompletion(openRouterApiKey, {
					model: AI_LABEL_MODEL,
					messages: message,
					// JSON Schema準拠の出力を強制する。型の揺れは parseLabelResponse が吸収する。
					responseFormat: {
						type: "json_schema",
						json_schema: {
							name: "label_extraction",
							schema: LABEL_JSON_SCHEMA as unknown as Record<string, unknown>,
							strict: false,
						},
					},
					maxTokens: AI_LABEL_MAX_OUTPUT_TOKENS,
					reasoning: { effort: plan.effort },
				});
				// **パースより先に報告する**。モデルが変な JSON を返した回こそ
				// 「モデルの応答が悪いのか・パース側が悪いのか」の切り分け材料で、
				// パース失敗で消えると写真1枚ぶんの推論が観測から漏れる。
				ctx.recordGeneration({
					name: `label_analysis:standard#photo${photoIndex + 1}`,
					model: AI_LABEL_MODEL,
					input: redact(message),
					output: response.text,
					metadata: {
						photos: photoSummaries.slice(photoIndex, photoIndex + 1),
					},
					usage: {
						inputTokens: response.usage.inputTokens,
						outputTokens: response.usage.outputTokens,
						totalTokens: totalTokens(response.usage),
					},
				});
				extractions.push(parseLabelResponse(response.text));
				// 写真ごとの usage を足し込む。
				usage = addUsage(usage, response.usage);
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
		// 全ての写真で失敗したら「推論失敗」として予約を全額返却する(呼び出し側の catch へ)。
		// 最後の失敗要因を cause に持たせ、全滅時の原因追跡を可能にする(#156)。
		if (!anyCallOk) {
			throw new Error("すべての写真の解析に失敗しました", {
				cause: lastPhotoErr,
			});
		}
	}
	const suggestions = buildLabelSuggestions(mergeExtractions(extractions));
	// **実行した経路のモデル単価で課金する**(降格が無いので route = 実行経路)。
	const measured = chargeFor(AI_LABEL_ROUTE_MODELS[route], usage);
	let charge: CreditCharge;
	if (measured.microUsd > 0) {
		charge = measured;
	} else {
		// 実測が取れなかった回の床は**実行した経路の見積**にする(#404)。
		charge = fallbackCharge(
			estimateLabelReserveCharge(route, imageDataUrls.length, plan.effort)
				.microUsd,
		);
		// 実測欠落の頻度を観測できるようにする。
		logWarn("label usage missing; charging the executed route estimate", {
			userId,
			requestId,
			route,
			executedBy: route,
			reservedMicroUsd: ctx.reservedMicroUsd,
			chargedMicroUsd: charge.microUsd,
		});
	}
	return { value: suggestions, charge, usage };
}

/**
 * 保存済みのジョブから推論を1回走らせ、実測で確定する(#460)。同期経路と**同じ推論本体**を
 * 通し、予約の確定・失敗時返却も同じ骨格(`finishMeteredInference`)に載せる。
 *
 * 呼ぶのはキュー・コンシューマ(label-job-service)だけ。ここに置いてあるのは
 * `runLabelInference` を ai-service の外へ公開しないため——推論本体は「予約済みの文脈で
 * しか呼んではいけない」関数で、単体で export すると予約なしで走らせる経路を作れてしまう。
 */
export async function runLabelAnalysisForJob(
	userId: string,
	input: {
		imageDataUrls: string[];
		plan: LabelPlan;
		reservation: MeteredInferenceReservation;
		/** durationMs の起点。投入からの待ち時間を推論時間に含めない */
		startedAt?: number;
	},
): Promise<FinishMeteredInferenceResult<LabelSuggestions>> {
	if (input.imageDataUrls.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	// 実行キーは予約後に読んでもよい(投入時の経路で予約が立っており、キーは
	// シークレットを D1 へ書かないため都度読む)。未設定なら推論せず失敗として
	// 返却する(経路の再解決はしない規約)。
	const apiKey = openRouterApiKey();
	if (!apiKey) {
		throw new HttpError(503, OPENROUTER_UNAVAILABLE_MESSAGE);
	}
	// 高精度プロンプトは Langfuse 管理下から引く(IMPL-3 W3-2)。**予約は投入時に
	// 済んでいる**が、`getManagedPrompt` は throw しない設計なので返却漏れは
	// 起きない。取得に失敗した回はコードの fallback 本文で動く。
	const prompts = await resolveLabelResearchPrompt(input.plan.route);
	return finishMeteredInference(
		userId,
		{
			reservation: input.reservation,
			logBase: input.plan.logBase,
			...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		},
		(ctx) =>
			runLabelInference(
				userId,
				{
					imageDataUrls: input.imageDataUrls,
					plan: input.plan,
					openRouterApiKey: apiKey,
					prompts,
				},
				ctx,
			),
	);
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

/**
 * 一括抽出でユーザに対して**実際に走る経路**。返せる経路が無ければ `null`(#426)。
 *
 * エチケット解析と同じ `preferredLabelEngine` を読み、`resolveWineListRoute` で
 * 一括抽出用に解決する(標準経路へは降格しない)。UI の必要クレジット表示と
 * `analyzeWineList` の予約が**同じ解決を通る**ようにするための単一の判定口。
 * 推論の深さも同じ D1 行から読むので一緒に戻す。
 */
export async function resolveWineListRouteForUser(
	userId: string,
): Promise<WineListRoute | null> {
	return (await resolveWineListRouteAndEffort(userId)).route;
}

async function resolveWineListRouteAndEffort(userId: string): Promise<{
	route: WineListRoute | null;
	effort: ReasoningEffortKey;
}> {
	const { preferredLabelEngine, preferredReasoningEffort } =
		await userService.getCurrentUser(userId);
	const engine =
		toLabelEngineKeyWithCompat(preferredLabelEngine) ?? DEFAULT_LABEL_ENGINE;
	return {
		route: resolveWineListRoute(engine, labelProviderAvailability()),
		effort:
			toReasoningEffortKey(preferredReasoningEffort) ??
			DEFAULT_REASONING_EFFORT,
	};
}

/**
 * 一括抽出が使える環境か(= OPENROUTER_API_KEY が設定されているか)。
 *
 * **この経路は標準経路へフォールバックしない**(#358 の決定を維持)ため、
 * キーが無い環境では機能そのものを出さない。UI の出し分けとサーバ側の拒否が
 * 同じ判定を見るよう、ここを単一の判定口にする。**ユーザ設定には依存しない**
 * (どのエンジンを選んでいても、OpenRouter 上の高精度経路に載る)。
 */
export function isWineListAnalysisAvailable(): boolean {
	return labelProviderAvailability().openrouter;
}

/**
 * Claude で全写真を1リクエスト解析し、銘柄配列を取り出す。env 非依存(apiKey を注入)で
 * 失敗は throw する(エチケット解析の高精度経路と同じ契約)。
 *
 * #602 で Anthropic SDK 直接接続から OpenRouter 経由へ移した。
 *
 * **web検索で裏を取る**(#474)。銘柄ごとにリクエストを立てず、1回の推論のサーバー側
 * ツールループの中でまとめて調べさせる——これが「銘柄数 × 検索でコストが発散する」
 * (#358 が裏取りを外した理由)への歯止めで、回数自体も `max_uses` で縛る。
 */
async function extractWineListWithClaude(
	apiKey: string,
	imageDataUrls: string[],
	obs?: InferenceObserver,
	/** Langfuse 管理下から引いた本文。省略時はコードの版を使う。 */
	promptText?: string,
	/** ユーザ設定の推論の深さ。low は reasoning 無指定(現行どおり)。 */
	effort: ReasoningEffortKey = DEFAULT_REASONING_EFFORT,
): Promise<{ parsed: WineListParseResult; usage: AiUsage }> {
	const messages = buildWineListMessages(
		imageDataUrls,
		promptText ?? buildWineListPrompt(imageDataUrls.length),
	);
	// Langfuse へ送る入力は**写真を要約へ置き換えた版**(#515)。写像の構築時に
	// ハッシュ計算(非同期)を済ませるのはエチケット解析と同じ。
	const redact = await createPhotoRedactor(imageDataUrls);
	const photoSummaries = await describePhotoSummaries(imageDataUrls);
	const response = await chatCompletion(apiKey, {
		model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
		messages,
		maxTokens: AI_WINE_LIST_MAX_OUTPUT_TOKENS,
		reasoning: anthropicReasoningForEffort(effort),
		tools: [
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "native",
					max_uses: AI_WINE_LIST_MAX_SEARCHES,
				},
			},
		],
	});
	const usage = response.usage;
	const trace = extractOpenRouterTrace(response.annotations);
	if (obs) {
		// モデル呼び出し1回 = generation 1件。**パースより先に報告する**(エチケット解析の
		// 標準経路と同じ理由で、応答の解釈に失敗してもモデルが何を返したかを残す)。
		obs.recordGeneration({
			name: `${AI_FEATURE_GENERATION_PREFIXES.wine_list_analysis}web-research#1`,
			model: AI_WINE_LIST_ROUTE_MODELS["web-research"],
			input: redact([...messages]),
			output: response.text,
			metadata: { photos: photoSummaries },
			usage: {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: totalTokens(usage),
			},
		});
		if (trace.steps.length > 0) {
			obs.recordSpan({
				name: "web_search",
				input: trace.steps.map((s) => ({ action: s.action, query: s.query })),
				output: trace.steps,
			});
		}
	}
	if (
		response.finishReason === "content_filter" ||
		(!response.text.trim() && response.finishReason !== "length")
	) {
		throw new Error("Claudeがワインリストの解析の応答を拒否しました");
	}
	// 出力上限で打ち切られた応答は JSON が途中で切れており、パースに回すと
	// 「形式が不正」という無関係な例外になる。銘柄が多すぎることが原因だと
	// ユーザが分かる形で返す(escape hatch: 写真を分けて再解析)。
	if (response.finishReason === "length") {
		throw new BadRequestError(WINE_LIST_TRUNCATED_ERROR_MESSAGE);
	}
	assertGptLabelFinished(response.finishReason);
	const parsed = parseWineListResponse(response.text, imageDataUrls.length);
	return { parsed, usage };
}

/**
 * GPT(OpenRouter chat completions)で全写真を1リクエスト解析し、銘柄配列を取り出す(#426)。
 * Claude 経路と同じ契約(env 非依存・失敗は throw)で、返す形も揃える。
 *
 * Claude 経路との違い:
 *  - structured outputs(response_format)で出力形式を強制する。指示文は共有しているので、
 *    形が保証されるぶんだけ Claude 経路より安全側になる
 *  - サーバー側ツールループを OpenRouter が回すので継続処理が要らない
 *    (`openrouter:web_search` はサーバーツールで、1リクエストの中で完結する)
 *
 * **web検索の回数は応答の `usage.server_tool_use.web_search_requests` に出る**
 * ($10/1000回 の回数課金)。トークンとは別建てのため、`toOpenRouterUsage` が
 * 拾う——ここを落とすと、この経路の原価の大きい部分が静かに漏れる。
 */
async function extractWineListWithGpt(
	apiKey: string,
	imageDataUrls: string[],
	obs?: InferenceObserver,
	/** Langfuse 管理下から引いた本文。省略時はコードの版を使う。 */
	promptText?: string,
	/** ユーザ設定の推論の深さ。 */
	effort: ReasoningEffortKey = DEFAULT_REASONING_EFFORT,
): Promise<{ parsed: WineListParseResult; usage: AiUsage }> {
	// Langfuse へ送る入力は**写真を要約へ置き換えた版**(#515)。ハッシュ計算の非同期は
	// ここで済ませてあるので、置き換えは同期で済む。
	const redact = await createPhotoRedactor(imageDataUrls);
	const photoSummaries = await describePhotoSummaries(imageDataUrls);
	const messages = buildWineListGptInput(
		imageDataUrls,
		promptText ?? buildWineListPrompt(imageDataUrls.length),
	);
	const response = await chatCompletion(apiKey, {
		model: AI_WINE_LIST_ROUTE_MODELS["gpt-luna"],
		messages,
		maxTokens: AI_WINE_LIST_GPT_MAX_OUTPUT_TOKENS,
		reasoning: { effort },
		responseFormat: buildWineListGptTextFormat(),
		tools: [
			{
				type: "openrouter:web_search",
				parameters: {
					engine: "native",
					search_context_size: AI_WINE_LIST_GPT_SEARCH_CONTEXT_SIZE,
				},
			},
		],
	});
	const usage = response.usage;
	const trace = extractOpenRouterTrace(response.annotations);
	if (obs) {
		// モデル呼び出し1回 = generation 1件。**パースより先に報告する**(エチケット解析の
		// 標準経路と同じ理由で、応答の解釈に失敗してもモデルが何を返したかを残す)。
		obs.recordGeneration({
			name: `${AI_FEATURE_GENERATION_PREFIXES.wine_list_analysis}gpt-luna#1`,
			model: AI_WINE_LIST_ROUTE_MODELS["gpt-luna"],
			input: redact(messages),
			output: response.text,
			metadata: { photos: photoSummaries },
			usage: {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: totalTokens(usage),
			},
		});
		if (trace.steps.length > 0) {
			obs.recordSpan({
				name: "web_search",
				input: trace.steps.map((s) => ({ action: s.action, query: s.query })),
				output: trace.steps,
			});
		}
	}
	assertWineListChatFinished(response.finishReason, response.text);
	const parsed = parseWineListResponse(response.text, imageDataUrls.length);
	return { parsed, usage };
}

/** 一括抽出の結果。ジョブ行にもこの形で載る(#474)。 */
export interface WineListAnalysisOutcome {
	candidates: WineListCandidate[];
	summary: WineListAnalysisSummary;
}

/**
 * 一括抽出の**推論本体**(#474)。同期経路(`analyzeWineList`)とジョブ経路
 * (`runWineListAnalysisForJob`)が共有する。エチケット解析の `runLabelInference` と
 * 同じ役割で、**予約済みの文脈でしか呼んではいけない**ためモジュール外へ出さない。
 *
 * 既存セラー(`entries`)を引数で受け取るのは、同期経路が**予約より前**に読む必要が
 * あるため(#245)。ジョブ経路は予約が投入時に済んでいるので、呼び出し側が読んでから渡す。
 */
async function runWineListInference(
	input: {
		imageDataUrls: string[];
		route: WineListRoute;
		/** ユーザがプロフィールで選んでいた推論の深さ(投入時に確定)。 */
		effort: ReasoningEffortKey;
		apiKey: string;
		entries: DrunkWineEntry[];
		/**
		 * Langfuse 管理下から引いたプロンプト。**呼び出し側
		 * (`runWineListAnalysisForJob`)が推論の実行直前に解決して渡す**
		 * (`runLabelInference` の prompts と同じ理由)。省略時はコードの版を使う。
		 */
		prompt?: ResolvedPrompt;
	},
	ctx: MeteredInferenceContext,
): Promise<MeteredInferenceOutput<WineListAnalysisOutcome>> {
	// **フォールバックは持たない**。片方の失敗でもう一方を叩くと、失敗した推論の
	// 原価に加えてもう1回ぶんの消費が乗る(#404 と同種の問題を作らない)。
	// Langfuse への報告口(#515)。キー未設定なら ctx 側が no-op するので常に定義してよい。
	const obs = withPromptAttribution(
		{
			recordGeneration: (gen) => ctx.recordGeneration(gen),
			recordSpan: (span) => ctx.recordSpan(span),
		},
		input.prompt,
	);
	const { parsed, usage } =
		input.route === "gpt-luna"
			? await extractWineListWithGpt(
					input.apiKey,
					input.imageDataUrls,
					obs,
					input.prompt?.text,
					input.effort,
				)
			: await extractWineListWithClaude(
					input.apiKey,
					input.imageDataUrls,
					obs,
					input.prompt?.text,
					input.effort,
				);
	const deduped = dedupeWineListItems(parsed.wines);
	const candidates = matchExistingEntries(
		buildWineListCandidates(deduped.items),
		input.entries,
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
	const measured = chargeFor(AI_WINE_LIST_ROUTE_MODELS[input.route], usage);
	const charge =
		measured.microUsd > 0 ? measured : fallbackCharge(ctx.reservedMicroUsd);
	// フォールバックが無いので実行経路は常に選択経路と一致する。
	ctx.addLogFields({ executedBy: input.route });
	return { value: { candidates, summary }, charge, usage };
}

/** 一括抽出ジョブの実行計画(#474)。`LabelPlan` と同じ役割・同じ使われ方。 */
export interface WineListPlan {
	route: WineListRoute;
	/** ユーザがプロフィールで選んでいた推論の深さ。ジョブ行に永続化し、コンシューマは再解決しない */
	effort: ReasoningEffortKey;
	estimate: CreditCharge;
	requestId: string;
	logBase: MeteredInferenceLogBase;
	photoCount: number;
}

/** 経路と枚数から、全ての結末に載る静的な実行メタデータを組む。 */
function buildWineListLogBase(options: {
	route: WineListRoute;
	effort: ReasoningEffortKey;
	photoCount: number;
}): MeteredInferenceLogBase {
	return {
		feature: "wine_list_analysis",
		// 一括抽出はフォールバックを持たない(#358)ので、選択と実行経路は常に一致する。
		selected: options.route,
		route: options.route,
		effort: options.effort,
		model: AI_WINE_LIST_ROUTE_MODELS[options.route],
		photoCount: options.photoCount,
	};
}

/**
 * 一括抽出ジョブの計画を立てる(#474)。**予約より前**に呼ぶ(D1読み + env 解決。#245)。
 * 使える経路が無い環境は 503——この機能は Workers AI へ降格しない(#358)。
 */
export async function resolveWineListPlan(
	userId: string,
	photoCount: number,
): Promise<WineListPlan> {
	const { route, effort } = await resolveWineListRouteAndEffort(userId);
	if (!route) {
		throw new HttpError(
			503,
			"この環境では写真からの一括登録を利用できません。管理者にお問い合わせください。",
		);
	}
	return {
		route,
		effort,
		estimate: estimateWineListReserveCharge(route, photoCount, effort),
		requestId: `scan_list:${crypto.randomUUID()}`,
		logBase: buildWineListLogBase({ route, effort, photoCount }),
		photoCount,
	};
}

/**
 * 保存済みのジョブから計画を復元する。**経路・effortは再解決しない**——予約は投入時の経路・
 * effortの見積で立っているため、コンシューマ側で解決し直すと予約と実行が食い違う
 * (`restoreLabelPlan` と同じ理由)。
 */
export function restoreWineListPlan(saved: {
	route: WineListRoute;
	effort: ReasoningEffortKey;
	photoCount: number;
	requestId: string;
}): WineListPlan {
	return {
		route: saved.route,
		effort: saved.effort,
		estimate: estimateWineListReserveCharge(
			saved.route,
			saved.photoCount,
			saved.effort,
		),
		requestId: saved.requestId,
		logBase: buildWineListLogBase(saved),
		photoCount: saved.photoCount,
	};
}

/**
 * 保存済みのジョブから一括抽出を1回走らせ、実測で確定する(#474)。
 * 同期経路と**同じ推論本体**を通す(`runLabelAnalysisForJob` と同じ形)。
 */
export async function runWineListAnalysisForJob(
	userId: string,
	input: {
		imageDataUrls: string[];
		plan: WineListPlan;
		reservation: MeteredInferenceReservation;
		startedAt?: number;
	},
): Promise<FinishMeteredInferenceResult<WineListAnalysisOutcome>> {
	if (input.imageDataUrls.length === 0) {
		throw new BadRequestError("画像が指定されていません");
	}
	const apiKey = openRouterApiKey();
	// 投入から実行までの間にシークレットが外れた場合。経路は再解決しない規約なので、
	// 実行できないことを失敗として扱う(予約は finishMeteredInference が返却する)。
	if (!apiKey) {
		throw new HttpError(
			503,
			"この環境では写真からの一括登録を利用できません。管理者にお問い合わせください。",
		);
	}
	// 既存セラーとの突合材料。予約は投入時に済んでいるので、ここで読んでよい。
	const { entries } = await drunkWineService.listDrunkWines(userId);
	// プロンプトは Langfuse 管理下から引く(IMPL-3 W3-2。`runLabelAnalysisForJob`
	// と同じく throw しないので、予約済みのここに置いても返却漏れは起きない)。
	const prompt = await resolveWineListResearchPrompt(
		input.imageDataUrls.length,
	);
	return finishMeteredInference(
		userId,
		{
			reservation: input.reservation,
			logBase: input.plan.logBase,
			...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
		},
		(ctx) =>
			runWineListInference(
				{
					imageDataUrls: input.imageDataUrls,
					route: input.plan.route,
					effort: input.plan.effort,
					apiKey,
					entries,
					prompt,
				},
				ctx,
			),
	);
}
