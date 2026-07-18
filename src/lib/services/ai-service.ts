import { env } from "cloudflare:workers";
import {
	AI_LABEL_MAX_OUTPUT_TOKENS,
	AI_LABEL_MODEL,
	AI_MAX_OUTPUT_TOKENS,
	AI_REGION_QA_MODEL,
} from "#/lib/ai/config";
import {
	buildLabelMessages,
	buildLabelSuggestions,
	estimateLabelReserveTokens,
	LABEL_JSON_SCHEMA,
	type LabelSuggestions,
	parseLabelResponse,
} from "#/lib/ai/label-extraction";
import {
	buildRegionChatMessages,
	type ChatMessage,
	estimateReserveTokens,
	type RegionContextInput,
	stripReasoning,
} from "#/lib/ai/region-qa";
import * as creditService from "#/lib/services/credit-service";
import { getAop, getRegion, getVariety, listAops } from "#/lib/wine/service";

// 地域チャットQ&Aのサービス層。Web サーバfn と MCP ツールの両方から呼ぶ単一の入口。
// グラウンディング材料を wine サービスから解決し、PR1 のクレジット予約→(Workers AI 実行)→
// 実測確定/失敗時返却の骨格(consumeCreditsDummy と同型)で1ターンを処理する。

export interface AskRegionInput {
	regionId: string;
	aopId?: string;
	question: string;
	/** クライアント保持の会話履歴(直近から。上限は region-qa 側でクランプ)。 */
	history?: ChatMessage[];
}

export type AskRegionResult =
	| { blocked: true; balance: number; required: number }
	| { blocked: false; answer: string; actualTokens: number; balance: number };

/** region/aop の静的データからグラウンディング材料を組み立てる。 */
function buildContext(regionId: string, aopId?: string): RegionContextInput {
	const region = getRegion(regionId);
	if (!region) throw new Error(`Unknown region: ${regionId}`);
	if (!region.enabled) throw new Error(`Region not yet available: ${regionId}`);

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

	try {
		const raw = await env.AI.run(AI_REGION_QA_MODEL, {
			messages,
			max_completion_tokens: AI_MAX_OUTPUT_TOKENS,
			// Gemma 4 は既定で thinking が有効。放置すると reasoning が出力枠(512)を先に
			// 使い切り、本文(content)が途中で切れる/空になる。地域Q&Aは簡潔な回答が目的で
			// 思考は不要なため無効化する(実測: 有効時 completion 512 で途中切れ →
			// 無効時 completion 65 で完結)。
			chat_template_kwargs: { enable_thinking: false },
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
		// 実測が取れなければ予約全量を実測とみなす(返却0=安全側)
		const actualTokens = out.usage?.total_tokens ?? res.reservedTokens;
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			actualTokens,
		);
		const after = await creditService.getBalance(userId);
		return { blocked: false, answer, actualTokens, balance: after.balance };
	} catch (e) {
		await creditService.refundReservation(
			userId,
			requestId,
			res.reservedCredits,
		);
		throw e;
	}
}

export interface AnalyzeLabelInput {
	/** エチケット画像の data URI(data:image/...;base64,...)。HTTP URLは不可。 */
	imageDataUrl: string;
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
	const messages = buildLabelMessages(input.imageDataUrl);
	const estimate = estimateLabelReserveTokens();
	const requestId = `analyze_label:${crypto.randomUUID()}`;

	const res = await creditService.reserveCredits(userId, estimate, requestId);
	if (!res.ok) {
		return { blocked: true, balance: res.balance, required: res.required };
	}

	try {
		const raw = await env.AI.run(AI_LABEL_MODEL, {
			messages,
			// JSON Schema準拠の出力を強制する(vLLM系のguided decoding)
			guided_json: LABEL_JSON_SCHEMA,
			max_tokens: AI_LABEL_MAX_OUTPUT_TOKENS,
		});
		const out = raw as {
			response?: string;
			usage?: { total_tokens?: number };
		};
		const suggestions = buildLabelSuggestions(
			parseLabelResponse(out.response ?? ""),
		);
		// 実測が取れなければ予約全量を実測とみなす(返却0=安全側)
		const actualTokens = out.usage?.total_tokens ?? res.reservedTokens;
		await creditService.settleReservation(
			userId,
			requestId,
			res.reservedCredits,
			actualTokens,
		);
		const after = await creditService.getBalance(userId);
		return {
			blocked: false,
			suggestions,
			actualTokens,
			balance: after.balance,
		};
	} catch (e) {
		await creditService.refundReservation(
			userId,
			requestId,
			res.reservedCredits,
		);
		throw e;
	}
}
