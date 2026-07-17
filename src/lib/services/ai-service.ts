import { env } from "cloudflare:workers";
import { AI_MAX_OUTPUT_TOKENS, AI_REGION_QA_MODEL } from "#/lib/ai/config";
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
		// GLM-5.2 は生成済み AiModelList に未収載で、出力上限は max_completion_tokens、
		// reasoning は reasoning_effort で制御する。モデル切替に耐えるよう緩い型で呼び、
		// max_tokens も併せて渡す(未対応キーは無視される)。
		const runAi = env.AI.run as unknown as (
			model: string,
			inputs: Record<string, unknown>,
		) => Promise<{ response?: string; usage?: { total_tokens?: number } }>;
		const out = await runAi(AI_REGION_QA_MODEL, {
			messages,
			max_completion_tokens: AI_MAX_OUTPUT_TOKENS,
			// 短いQ&Aなので思考は最小限に(冗長化と出力トークン=原価の増加を抑える)
			reasoning_effort: "low",
		});
		// reasoning モデルが <think>…</think> を混ぜても表示に出さない
		const answer = stripReasoning(out.response ?? "").trim();
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
