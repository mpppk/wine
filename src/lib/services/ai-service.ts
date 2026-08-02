import { env } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
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
	AI_WINE_LIST_MAX_OUTPUT_TOKENS,
	AI_WINE_LIST_MODEL,
	DEFAULT_LABEL_ENGINE,
	DEFAULT_REGION_QA_MODEL,
	estimateWineListReserveTokens,
	type LabelRoute,
	type RegionQaModelKey,
	resolveLabelRoute,
	toLabelEngineKey,
	toRegionQaModelKey,
} from "#/lib/ai/config";
import { logAiInference } from "#/lib/ai/inference-log";
import {
	buildLabelMessages,
	buildLabelSuggestions,
	estimateLabelReserveTokens,
	LABEL_JSON_SCHEMA,
	type LabelExtraction,
	type LabelSuggestions,
	mergeExtractions,
	parseLabelResponse,
} from "#/lib/ai/label-extraction";
import {
	buildGptLabelInput,
	buildGptLabelTextFormat,
	estimateGptLabelReserveTokens,
	extractGptLabelText,
} from "#/lib/ai/label-gpt-research";
import {
	buildWebLabelMessages,
	estimateWebLabelReserveTokens,
	joinResponseText,
	sumAnthropicUsage,
} from "#/lib/ai/label-web-research";
import {
	buildRegionChatMessages,
	type ChatMessage,
	estimateReserveTokens,
	type RegionContextInput,
	stripReasoning,
} from "#/lib/ai/region-qa";
import {
	buildWineListCandidates,
	buildWineListMessages,
	dedupeWineListItems,
	matchExistingEntries,
	parseWineListResponse,
	type WineListCandidate,
	type WineListParseResult,
} from "#/lib/ai/wine-list-extraction";
import { BadRequestError, HttpError } from "#/lib/errors";
import { logWarn } from "#/lib/logger";
import { MAX_PHOTOS_PER_IMPORT_BATCH } from "#/lib/place/schema";
import * as creditService from "#/lib/services/credit-service";
import * as drunkWineService from "#/lib/services/drunk-wine-service";
import * as userService from "#/lib/services/user-service";
import { getAop, getRegion, getVariety, listAops } from "#/lib/wine/service";

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
	const estimate = estimateReserveTokens(messages);
	const requestId = `ask_region:${crypto.randomUUID()}`;

	// プロフィール設定(または明示指定)→ 実モデルID＋固有オプションに解決。
	// **予約より前**に解決する(#245)。明示指定が無ければ D1 を読むため、一時エラーや
	// NotFoundError で throw しうる。予約の後・try の外でこれを await すると、その throw が
	// 下の catch(refundReservationOnFailure)に届かず、予約が返却も記録もされずに消える。
	// モデル解決は予約と独立なので、先に済ませて「予約したら必ず try で囲まれている」形にする。
	const startedAt = Date.now();
	const modelKey = await resolveModelKey(userId, input.model);
	const model = AI_REGION_QA_MODELS[modelKey];
	// 実行記録の共通部分。経路ごとに組み立て直すとフィールドがドリフトするため1つ持つ。
	const logBase = {
		feature: "region_qa",
		userId,
		requestId,
		selected: modelKey,
		// 地域Q&Aはフォールバック経路が無いので、意図した経路＝実行経路。
		route: modelKey,
		model: model.id,
	} as const;

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		logAiInference({
			...logBase,
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
		});
		return { blocked: true, balance: res.balance, required: res.required };
	}

	let answer: string;
	let actualTokens: number;
	try {
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
		answer = stripReasoning(rawText).trim();
		// 実測が取れなければ予約全量を実測とみなす(返却0=安全側)
		actualTokens = out.usage?.total_tokens ?? res.reservedTokens;
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			actualTokens,
		);
	} catch (e) {
		// 返却を試み、成否をログに残す。返却自体が失敗しても元の推論失敗例外 e を握り
		// 潰さず伝播する(#158)。
		await creditService.refundReservationOnFailure(
			userId,
			requestId,
			res.reservedCredits,
		);
		logAiInference({
			...logBase,
			outcome: "failed",
			durationMs: Date.now() - startedAt,
			reservedTokens: res.reservedTokens,
			err: e,
		});
		throw e;
	}
	logAiInference({
		...logBase,
		outcome: "ok",
		executedBy: modelKey,
		durationMs: Date.now() - startedAt,
		actualTokens,
		reservedTokens: res.reservedTokens,
	});
	// settle 成功後は消費確定済み。getBalance の失敗で catch の全額返却が走ると消費が
	// ネットプラスになるため、残高参照は try の外で行う(#144)。
	const after = await creditService.getBalance(userId);
	return { blocked: false, answer, actualTokens, balance: after.balance };
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

/**
 * 高精度経路: Claude(マルチモーダル + サーバーサイドweb検索)で全写真を1リクエスト
 * 解析し、生産者公式サイト・ワインDBでの裏取り込みの抽出結果を返す。
 * env 非依存(apiKey を注入)で、失敗は throw する(フォールバック判断は呼び出し側)。
 */
async function analyzeLabelWithWebResearch(
	apiKey: string,
	imageDataUrls: string[],
): Promise<{ extraction: LabelExtraction; totalTokens: number }> {
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
	let totalTokens = sumAnthropicUsage(response.usage);
	// サーバー側ツールループ(web検索)が上限に達すると pause_turn で返る。assistant 応答を
	// 積んで再送すると続きから再開する(継続回数は原価ガードとして上限で打ち切る)。
	for (
		let i = 0;
		i < AI_LABEL_WEB_MAX_CONTINUATIONS && response.stop_reason === "pause_turn";
		i++
	) {
		messages.push({ role: "assistant", content: response.content });
		response = await client.messages.create({ ...request, messages });
		totalTokens += sumAnthropicUsage(response.usage);
	}
	// claude-opus-5 はセーフティ分類器が HTTP 200 + stop_reason: "refusal" で応答を
	// 拒否しうる。content が空/不完全なので通常の失敗として扱う(Workers AI へフォールバック)。
	if (response.stop_reason === "refusal") {
		throw new Error("Claudeがエチケット解析の応答を拒否しました");
	}
	const extraction = parseLabelResponse(joinResponseText(response.content));
	return { extraction, totalTokens };
}

/**
 * 高精度経路: OpenAI GPT-5.6 Luna(マルチモーダル + サーバーサイドweb検索)で全写真を
 * 1リクエスト解析する。Claude経路と同じ契約(env 非依存・失敗は throw してフォールバックは
 * 呼び出し側)で、返す形も揃える。
 *
 * Claude経路と違い pause_turn の継続ループが要らない: Responses API は web検索の
 * ツールループをサーバー側で完走させてから1つの応答を返す。打ち切りは
 * status="incomplete" として表面化するので、extractGptLabelText がそれを throw に変える。
 */
async function analyzeLabelWithGptResearch(
	apiKey: string,
	imageDataUrls: string[],
): Promise<{ extraction: LabelExtraction; totalTokens: number }> {
	const client = new OpenAI({ apiKey });
	const response = await client.responses.create({
		model: AI_LABEL_GPT_MODEL,
		input: buildGptLabelInput(imageDataUrls),
		max_output_tokens: AI_LABEL_GPT_MAX_OUTPUT_TOKENS,
		reasoning: { effort: AI_LABEL_GPT_REASONING_EFFORT },
		tools: [
			{
				type: "web_search",
				search_context_size: AI_LABEL_GPT_SEARCH_CONTEXT_SIZE,
			},
		],
		text: buildGptLabelTextFormat(),
	});
	// total_tokens は入力(キャッシュ含む)+ 出力(reasoning 含む)の総和で、サーバー側
	// ツールループのぶんも合算済み。取れなければ 0 を返し、呼び出し側が予約全量を
	// 実測とみなす(返却0=安全側)。
	const totalTokens = response.usage?.total_tokens ?? 0;
	const extraction = parseLabelResponse(extractGptLabelText(response));
	return { extraction, totalTokens };
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
	const estimate =
		route === "gpt-luna"
			? estimateGptLabelReserveTokens(input.imageDataUrls.length)
			: route === "web-research"
				? estimateWebLabelReserveTokens(input.imageDataUrls.length)
				: estimateLabelReserveTokens(input.imageDataUrls.length);
	const requestId = `analyze_label:${crypto.randomUUID()}`;
	const startedAt = Date.now();
	const logBase = {
		feature: "label_analysis",
		userId,
		requestId,
		selected: engine,
		route,
		photoCount: input.imageDataUrls.length,
	} as const;

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		logAiInference({
			...logBase,
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
		});
		return { blocked: true, balance: res.balance, required: res.required };
	}

	let suggestions: LabelSuggestions;
	let actualTokens: number;
	// 実際に結果を出した経路。高精度経路が失敗すると route と食い違う(=フォールバック)。
	// route だけを記録すると「GPTで成功」と「GPTが落ちてWorkers AIが拾った」を
	// 区別できないため、別に持って実行記録に載せる。
	let executedBy: LabelRoute | undefined;
	try {
		let totalTokens = 0;
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
				);
				extractions.push(gpt.extraction);
				totalTokens += gpt.totalTokens;
				executedBy = "gpt-luna";
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
				);
				extractions.push(web.extraction);
				totalTokens += web.totalTokens;
				executedBy = "web-research";
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
			for (const [photoIndex, imageDataUrl] of input.imageDataUrls.entries()) {
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
					totalTokens += out.usage?.total_tokens ?? 0;
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
			executedBy = "workers-ai";
		}
		suggestions = buildLabelSuggestions(mergeExtractions(extractions));
		// 実測が取れなければ予約全量を実測とみなす(返却0=安全側)
		actualTokens = totalTokens || res.reservedTokens;
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			actualTokens,
		);
	} catch (e) {
		// 返却を試み成否をログに残す。返却失敗でも元の例外 e を伝播する(#158)。
		await creditService.refundReservationOnFailure(
			userId,
			requestId,
			res.reservedCredits,
		);
		logAiInference({
			...logBase,
			outcome: "failed",
			executedBy,
			model: executedBy && AI_LABEL_ROUTE_MODELS[executedBy],
			durationMs: Date.now() - startedAt,
			reservedTokens: res.reservedTokens,
			err: e,
		});
		throw e;
	}
	logAiInference({
		...logBase,
		outcome: "ok",
		executedBy,
		model: executedBy && AI_LABEL_ROUTE_MODELS[executedBy],
		durationMs: Date.now() - startedAt,
		actualTokens,
		reservedTokens: res.reservedTokens,
	});
	// settle 成功後は消費確定済み。getBalance の失敗で catch の全額返却が走ると消費が
	// ネットプラスになるため、残高参照は try の外で行う(#144)。
	const after = await creditService.getBalance(userId);
	return {
		blocked: false,
		suggestions,
		actualTokens,
		balance: after.balance,
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
 * 一括抽出が使える環境か(= ANTHROPIC_API_KEY が設定されているか)。
 *
 * **この経路は Claude 専用でフォールバックを持たない**(Issue #358 の決定)ため、
 * キーが無い環境では機能そのものを出さない。UI の出し分けとサーバ側の拒否が
 * 同じ判定を見るよう、ここを単一の判定口にする。
 */
export function isWineListAnalysisAvailable(): boolean {
	return !!env.ANTHROPIC_API_KEY?.trim();
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
): Promise<{ parsed: WineListParseResult; totalTokens: number }> {
	const client = new Anthropic({ apiKey });
	const response = await client.messages.create({
		model: AI_WINE_LIST_MODEL,
		max_tokens: AI_WINE_LIST_MAX_OUTPUT_TOKENS,
		messages: buildWineListMessages(imageDataUrls),
	});
	const totalTokens = sumAnthropicUsage(response.usage);
	if (response.stop_reason === "refusal") {
		throw new Error("Claudeがワインリストの解析の応答を拒否しました");
	}
	// 出力上限で打ち切られた応答は JSON が途中で切れており、パースに回すと
	// 「形式が不正」という無関係な例外になる。銘柄が多すぎることが原因だと
	// ユーザが分かる形で返す(escape hatch: 写真を分けて再解析)。
	if (response.stop_reason === "max_tokens") {
		throw new BadRequestError(
			"写真に写っているワインが多すぎて、解析結果を最後まで受け取れませんでした。写真を分けて解析してください。",
		);
	}
	const parsed = parseWineListResponse(
		joinResponseText(response.content),
		imageDataUrls.length,
	);
	return { parsed, totalTokens };
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
	const apiKey = env.ANTHROPIC_API_KEY?.trim();
	if (!apiKey) {
		// UI 側は isWineListAnalysisAvailable で導線ごと隠すので、ここに来るのは
		// 直接APIを叩かれた場合。機能が無効な環境であることを 503 で明示する。
		throw new HttpError(
			503,
			"この環境では写真からの一括登録を利用できません。管理者にお問い合わせください。",
		);
	}

	// 既存セラーとの突合材料。D1 読みなので予約より前に済ませる(#245)。
	const { entries } = await drunkWineService.listDrunkWines(userId);
	const estimate = estimateWineListReserveTokens(input.imageDataUrls.length);
	const requestId = `scan_list:${crypto.randomUUID()}`;
	const startedAt = Date.now();
	const logBase = {
		feature: "wine_list_analysis",
		userId,
		requestId,
		// 一括抽出は Claude 単経路(キーが無ければ上で 503)。フォールバックは無い。
		selected: "web-research",
		route: "web-research",
		model: AI_WINE_LIST_MODEL,
		photoCount: input.imageDataUrls.length,
	} as const;

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		logAiInference({
			...logBase,
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
		});
		return { blocked: true, balance: res.balance, required: res.required };
	}

	let candidates: WineListCandidate[];
	let summary: WineListAnalysisSummary;
	let actualTokens: number;
	try {
		const { parsed, totalTokens } = await extractWineListWithClaude(
			apiKey,
			input.imageDataUrls,
		);
		const deduped = dedupeWineListItems(parsed.wines);
		candidates = matchExistingEntries(
			buildWineListCandidates(deduped.items),
			entries,
		);
		summary = {
			detected: candidates.length,
			mergedDuplicates: deduped.mergedCount,
			matchedExisting: candidates.filter((c) => !!c.existing).length,
			truncated: parsed.truncated,
		};
		// 実測が取れなければ予約全量を実測とみなす(返却0=安全側)
		actualTokens = totalTokens || res.reservedTokens;
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			actualTokens,
		);
	} catch (e) {
		// 返却を試み成否をログに残す。返却失敗でも元の例外 e を伝播する(#158)。
		await creditService.refundReservationOnFailure(
			userId,
			requestId,
			res.reservedCredits,
		);
		logAiInference({
			...logBase,
			outcome: "failed",
			durationMs: Date.now() - startedAt,
			reservedTokens: res.reservedTokens,
			err: e,
		});
		throw e;
	}
	logAiInference({
		...logBase,
		outcome: "ok",
		executedBy: "web-research",
		durationMs: Date.now() - startedAt,
		actualTokens,
		reservedTokens: res.reservedTokens,
	});
	// settle 成功後は消費確定済み(#144)。
	const after = await creditService.getBalance(userId);
	return {
		blocked: false,
		candidates,
		summary,
		actualTokens,
		balance: after.balance,
	};
}
