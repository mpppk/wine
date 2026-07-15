import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	AI_MAX_HISTORY_MESSAGES,
	AI_MAX_OUTPUT_TOKENS,
	CHARS_PER_TOKEN_ESTIMATE,
} from "./config";

// 地域チャットQ&Aのプロンプト生成・履歴クランプ・トークン見積。DB/env/データ非依存の
// 純ロジックとして切り出し、単体テスト可能にする(グラウンディング材料は ai-service が解決して渡す)。

/** クライアント保持の会話履歴の1メッセージ。 */
export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

/** Workers AI(env.AI.run)に渡すメッセージ。system を先頭に置ける。 */
export interface AiMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** グラウンディング材料。値は ai-service が wine サービスから解決して渡す。 */
export interface RegionContextInput {
	regionNameJa: string;
	regionNameLocal: string;
	countryJa: string;
	regionDescription: string;
	subregionNames: string[];
	/** その地域の主なAOP名(コンパクトな一覧)。 */
	aopNames: string[];
	/** 選択中のAOP(あれば)。 */
	aop?: {
		nameJa: string;
		shortName: string;
		kind: "regional" | "village" | "vineyard" | "winery";
		soil: string;
		description: string;
		grapeLabels: string[];
		producerNames: string[];
	};
}

type AopKindLabel = NonNullable<RegionContextInput["aop"]>["kind"];
const KIND_JA: Record<AopKindLabel, string> = {
	regional: "地方名",
	village: "村名",
	vineyard: "畑",
	winery: "生産者(シャトー等)",
};

/** グラウンディングのコンテキスト上限(文字)。system が肥大しないよう約1KBに収める。 */
const CONTEXT_MAX_CHARS = 1200;
/** AOP名一覧の上限(文字)。 */
const AOP_NAMES_MAX_CHARS = 400;

/** 配列を区切り連結しつつ最大長で切り詰める(超過分は「ほか」で表す)。 */
function joinCapped(items: string[], maxChars: number): string {
	const out: string[] = [];
	let len = 0;
	for (const item of items) {
		const add = (out.length ? 1 : 0) + item.length;
		if (len + add > maxChars) {
			out.push("ほか");
			break;
		}
		out.push(item);
		len += add;
	}
	return out.join("、");
}

/** グラウンディング用の地域情報テキストを組み立てる(1KB目安で切り詰める)。 */
export function buildRegionContext(input: RegionContextInput): string {
	const lines: string[] = [
		`地域: ${input.regionNameJa}（${input.regionNameLocal} / ${input.countryJa}）`,
		`概要: ${input.regionDescription}`,
	];
	if (input.subregionNames.length) {
		lines.push(`主なサブ地区: ${joinCapped(input.subregionNames, 200)}`);
	}
	if (input.aopNames.length) {
		lines.push(
			`この地域の主なAOP: ${joinCapped(input.aopNames, AOP_NAMES_MAX_CHARS)}`,
		);
	}
	if (input.aop) {
		const a = input.aop;
		lines.push(
			`注目AOP: ${a.nameJa}（${a.shortName} / 区分: ${KIND_JA[a.kind]}）`,
		);
		if (a.description) lines.push(`  解説: ${a.description}`);
		if (a.soil) lines.push(`  土壌: ${a.soil}`);
		if (a.grapeLabels.length)
			lines.push(`  主なブドウ: ${joinCapped(a.grapeLabels, 200)}`);
		if (a.producerNames.length)
			lines.push(`  主な生産者: ${joinCapped(a.producerNames, 200)}`);
	}
	const text = lines.join("\n");
	return text.length > CONTEXT_MAX_CHARS
		? `${text.slice(0, CONTEXT_MAX_CHARS)}…`
		: text;
}

/** system プロンプト(ガードレール + 地域情報)を組み立てる。 */
export function buildSystemPrompt(input: RegionContextInput): string {
	return [
		"あなたはワイン産地の学習を助ける日本語アシスタントです。",
		"以下の「地域情報」だけを根拠に、簡潔(3〜5文程度)な日本語で答えてください。",
		"- 地域情報に無いことは推測せず「その情報はありません」と述べる。",
		"- ワインおよびこの地域と無関係な質問には丁寧に断る。",
		"- 事実を創作しない。",
		"",
		"# 地域情報",
		buildRegionContext(input),
	].join("\n");
}

/** 会話履歴を直近 AI_MAX_HISTORY_MESSAGES 件に切り詰める(古い順に落とす)。 */
export function clampHistory(history: ChatMessage[]): ChatMessage[] {
	if (history.length <= AI_MAX_HISTORY_MESSAGES) return history;
	return history.slice(history.length - AI_MAX_HISTORY_MESSAGES);
}

/** Workers AI に渡す messages(system + 直近履歴 + 新規質問)を組み立てる。 */
export function buildRegionChatMessages(args: {
	context: RegionContextInput;
	history: ChatMessage[];
	question: string;
}): AiMessage[] {
	return [
		{ role: "system", content: buildSystemPrompt(args.context) },
		...clampHistory(args.history),
		{ role: "user", content: args.question },
	];
}

/** テキストの粗いトークン見積(日本語混在を保守的に)。 */
export function estimatePromptTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * 予約すべきトークン数の見積。全メッセージの推定トークン + 出力上限。上限で必ずクランプする
 * (予約が実測を必ず上回るよう保守的に見積る)。
 */
export function estimateReserveTokens(messages: AiMessage[]): number {
	const promptTokens = messages.reduce(
		(sum, m) => sum + estimatePromptTokens(m.content),
		0,
	);
	return Math.min(AI_MAX_ESTIMATE_TOKENS, promptTokens + AI_MAX_OUTPUT_TOKENS);
}
