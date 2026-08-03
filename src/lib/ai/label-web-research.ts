import type Anthropic from "@anthropic-ai/sdk";
import type { AiUsage } from "#/lib/billing/ai-pricing";
import { buildWebLabelPrompt, parseImageDataUrl } from "./label-extraction";

// エチケット解析の高精度経路(Anthropic Claude + web検索)の純ロジック。
// メッセージ組み立て・応答の取り出し・見積を DB/env 非依存で切り出し、単体テスト可能に
// する(Anthropic API の実行とクレジット処理・フォールバックは ai-service 側)。
// 指示文と data URI の検証は provider 非依存なので label-extraction.ts に置き、
// GPT経路(label-gpt-research.ts)と共有する。
//
// Workers AI 経路(label-extraction.ts)との違い:
//  - 全写真を1リクエストに載せ、表・裏ラベルを突き合わせて総合判断させる
//  - web検索で生産者公式サイト・ワインDBを裏取りし、綴りの修正・呼称の特定・
//    ラベル未記載のセパージュの補完まで行わせる
//  - 出力の呼称・品種はアプリのマスタ表記に寄せさせ、matchAop / matchGrapeVarietyIds
//    のヒット率を上げる(マスタ名の一覧をプロンプトに同梱する)

/**
 * 指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる。
 * Workers AI 経路と異なり1リクエストに全photoを載せる(Claude は複数画像の
 * 突き合わせが安定しており、表ラベルの呼称と裏ラベルの品種を統合できる)。
 */
export function buildWebLabelMessages(
	imageDataUrls: string[],
): Anthropic.MessageParam[] {
	const content: Anthropic.ContentBlockParam[] = [
		{ type: "text", text: buildWebLabelPrompt() },
	];
	for (const dataUrl of imageDataUrls) {
		const { mediaType, data } = parseImageDataUrl(dataUrl);
		content.push({
			type: "image",
			source: {
				type: "base64",
				// クライアントは jpeg/png/webp 等に限定して送る(validateDeclaredPhotoFiles)
				media_type: mediaType as "image/jpeg",
				data,
			},
		});
	}
	return [{ role: "user", content }];
}

/**
 * 応答の content からテキストブロックだけを連結する。thinking ブロック(空文字)や
 * web検索の結果ブロックは無視する。得られた文字列を parseLabelResponse に渡す。
 */
export function joinResponseText(
	content: Array<{ type: string; text?: string }>,
): string {
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/**
 * Anthropic の usage をクレジット計上用の `AiUsage` へ変換する。
 *
 * **入力・出力・キャッシュを畳まずに分けて返す**のが要点(#355)。出力単価は入力の
 * 5倍、キャッシュ読み出しは入力の 1/10 で、合計トークンからは原価が復元できない。
 *
 * `server_tool_use.web_search_requests` も載せる。web検索は $10/1000回 の**回数課金**で
 * トークンとは別建てのため、ここを落とすと Claude 経路の原価の2割が計上から漏れる
 * (転換前は実際に漏れていた)。
 *
 * サーバー側ツールループの再送・pause_turn 継続のぶんは、呼び出し側が `addUsage` で
 * リクエストごとに加算する。
 */
export function toAnthropicUsage(usage: {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	server_tool_use?: { web_search_requests?: number | null } | null;
}): AiUsage {
	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		webSearches: usage.server_tool_use?.web_search_requests ?? 0,
	};
}
