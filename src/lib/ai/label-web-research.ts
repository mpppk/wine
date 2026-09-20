import { buildWebLabelPrompt, parseImageDataUrl } from "./label-extraction";
import type { OpenRouterMessage, OpenRouterUserContent } from "./openrouter";

// エチケット解析の高精度経路(Claude + web検索)の純ロジック。
// メッセージ組み立て・応答の取り出し・見積を DB/env 非依存で切り出し、単体テスト可能に
// する(OpenRouter API の実行とクレジット処理は ai-service 側)。
// 指示文と data URI の検証は provider 非依存なので label-extraction.ts に置き、
// GPT経路(label-gpt-research.ts)と共有する。
//
// #602 で Anthropic SDK 直接接続から OpenRouter 経由へ移した。メッセージは OpenAI chat
// 形式で組み立て、web検索は `openrouter:web_search` サーバーツール(engine native →
// Anthropic ネイティブ検索)で実行する。サーバー側ツールループは OpenRouter 側で
// 完結するため、pause_turn の継続処理は要らない(回数上限は max_uses で縛る)。
// usage・検索回数は応答の usage(`toOpenRouterUsage`)から取る。
//
// Workers AI 経路(旧 label-extraction.ts)との違い:
//  - 全写真を1リクエストに載せ、表・裏ラベルを突き合わせて総合判断させる
//  - web検索で生産者公式サイト・ワインDBを裏取りし、綴りの修正・呼称の特定・
//    ラベル未記載のセパージュの補完まで行わせる
//  - 出力の呼称・品種はアプリのマスタ表記に寄せさせ、matchAop / matchGrapeVarietyIds
//    のヒット率を上げる(マスタ名の一覧をプロンプトに同梱する)

/**
 * 指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる(OpenAI chat 形式)。
 * 全photoを載せ、表ラベルの呼称と裏ラベルの品種を突き合わせて総合判断させる。
 *
 * 指示文は差し替え可能にする。ai-service は Langfuse 管理下の版
 * (`LABEL_WEB_RESEARCH_PROMPT`)を引いた本文を渡し、省略時はコードの版を使う。
 */
export function buildWebLabelMessages(
	imageDataUrls: string[],
	promptText: string = buildWebLabelPrompt(),
): OpenRouterMessage[] {
	const content: OpenRouterUserContent = [{ type: "text", text: promptText }];
	for (const dataUrl of imageDataUrls) {
		// data URI でなければここで throw する(境界の強制)
		parseImageDataUrl(dataUrl);
		content.push({ type: "image_url", image_url: { url: dataUrl } });
	}
	return [{ role: "user", content }];
}
