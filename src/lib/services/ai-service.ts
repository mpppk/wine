import { env } from "cloudflare:workers";
import {
	AI_LABEL_MAX_OUTPUT_TOKENS,
	AI_LABEL_MODEL,
	AI_MAX_OUTPUT_TOKENS,
	AI_REGION_QA_MODELS,
	DEFAULT_REGION_QA_MODEL,
	REGION_QA_MODEL_KEYS,
	type RegionQaModelKey,
} from "#/lib/ai/config";
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
	buildRegionChatMessages,
	type ChatMessage,
	estimateReserveTokens,
	type RegionContextInput,
	stripReasoning,
} from "#/lib/ai/region-qa";
import { BadRequestError } from "#/lib/errors";
import { logWarn } from "#/lib/logger";
import * as creditService from "#/lib/services/credit-service";
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
	return (REGION_QA_MODEL_KEYS as readonly string[]).includes(
		preferredAiModel ?? "",
	)
		? (preferredAiModel as RegionQaModelKey)
		: DEFAULT_REGION_QA_MODEL;
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

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		return { blocked: true, balance: res.balance, required: res.required };
	}

	// プロフィール設定(または明示指定)→ 実モデルID＋固有オプションに解決。
	const model = AI_REGION_QA_MODELS[await resolveModelKey(userId, input.model)];

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
		throw e;
	}
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
 * エチケット画像を Workers AI(マルチモーダル)で解析し、マイセラーの自動入力候補を返す。
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
	const estimate = estimateLabelReserveTokens(input.imageDataUrls.length);
	const requestId = `analyze_label:${crypto.randomUUID()}`;

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		return { blocked: true, balance: res.balance, required: res.required };
	}

	let suggestions: LabelSuggestions;
	let actualTokens: number;
	try {
		// 写真は1枚ずつ解析して抽出結果をマージする(総合判断はマージ側で行う)。
		// 1枚ずつにするのは、複数画像を1リクエストに載せる方式の可否がモデル/環境で
		// 不安定なのを避けるためと、ある1枚の解析失敗(モデルがJSONを返さない等)で
		// 全体を落とさないため。個々の失敗はスキップし、全滅時のみ例外にする。
		let totalTokens = 0;
		let anyCallOk = false;
		let lastPhotoErr: unknown;
		const extractions: LabelExtraction[] = [];
		for (const [photoIndex, imageDataUrl] of input.imageDataUrls.entries()) {
			try {
				const raw = await env.AI.run(AI_LABEL_MODEL, {
					messages: buildLabelMessages(imageDataUrl),
					// JSON Schema準拠の出力を強制する(vLLM系のguided decoding)
					guided_json: LABEL_JSON_SCHEMA,
					max_tokens: AI_LABEL_MAX_OUTPUT_TOKENS,
				});
				const out = raw as {
					response?: string;
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
		throw e;
	}
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
