import type Anthropic from "@anthropic-ai/sdk";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	AI_LABEL_WEB_BASE_TOKEN_ESTIMATE,
	AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE,
} from "./config";
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
 * Anthropic の usage をクレジット計上用の合計トークンへ畳む。入力(キャッシュ
 * 読み書き含む)+出力の総和。サーバー側ツールループの再送・pause_turn 継続の
 * ぶんは呼び出し側でリクエストごとに加算する。
 */
export function sumAnthropicUsage(usage: {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.output_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	);
}

/**
 * Claude経路の予約トークン見積。web検索結果・ツールループの再送が支配的で事前に
 * 読めないため、基礎値を大きめに取り settle の実測確定で差分を返す。上限で必ず
 * クランプする(Workers AI 経路の estimateLabelReserveTokens と同じ流儀)。
 */
export function estimateWebLabelReserveTokens(imageCount: number): number {
	return Math.min(
		AI_MAX_ESTIMATE_TOKENS,
		AI_LABEL_WEB_BASE_TOKEN_ESTIMATE +
			AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE * Math.max(1, imageCount),
	);
}
