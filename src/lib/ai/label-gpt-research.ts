import { buildAgentLabelPrompt, parseImageDataUrl } from "./label-extraction";
import type { OpenRouterMessage, OpenRouterUserContent } from "./openrouter";

// エチケット解析の高精度経路(GPT-5.6 Luna + web検索)の純ロジック。
// 入力組み立て・usage 変換を DB/env 非依存で切り出し、単体テスト可能に
// する(API の実行とクレジット処理は ai-service 側)。
//
// **この経路は OpenRouter の chat completions でエージェントループを回す**
// (#602 で OpenAI 直結 + AI SDK から移行)。`analyzeLabelWithGptResearch` が
// リクエストを投げ、function ツールの実行だけをアプリ側で行う:
//  - リクエストは OpenAI chat 形式のメッセージ + ツール群(`openrouter:web_search` +
//    `submit_answer` 等)で組み立てる。web検索はサーバーツールとして OpenRouter 側で
//    実行され、1リクエストの中で完走する(使用回数は応答の
//    `usage.server_tool_use.web_search_requests` に出る)。
//  - 回答は `submit_answer` の呼び出しでのみ受け取る。本文にJSONを書かせない
//    (`buildAgentLabelPrompt` が `buildWebLabelPrompt` の「JSONだけを出力」指示を持たないのはこのため)
//  - usage は `toOpenRouterUsage` が変換する。
//  - 画像は **image_url パート(data URI)で渡す**。HTTP URL は渡せないよう
//    parseImageDataUrl で強制する。
//
// Claude経路(label-web-research.ts)は1リクエスト完結で `buildWebLabelPrompt` を使うが、
// GPT経路はエージェントループで `buildAgentLabelPrompt` を使う。裏取りの規範と出力フィールドの
// 定義は共有している(SSOT)。違うのは「1回で出し切る」か「ツールを使って収束させる」かという進め方だけ。

/** web検索サーバーツールの呼び出し名。計上と軌跡の抽出が同じ名前を見る。 */
export const GPT_WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * エージェントループ用の指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる。
 * 1リクエストに全photoを載せ、表ラベルの呼称と裏ラベルの品種を突き合わせて総合判断させる。
 *
 * 画像は data URI をそのまま渡せるが、**HTTP URL を渡せてしまう**ため
 * parseImageDataUrl を通して data URI であることを強制する(Claude経路と同じ境界)。
 *
 * 指示文は差し替え可能にする(`buildWebLabelMessages` の promptText と同じ理由)。
 */
export function buildGptLabelMessages(
	imageDataUrls: string[],
	promptText: string = buildAgentLabelPrompt(),
): OpenRouterMessage[] {
	const content: OpenRouterUserContent = [{ type: "text", text: promptText }];
	for (const dataUrl of imageDataUrls) {
		// data URI でなければここで throw する(境界の強制)
		parseImageDataUrl(dataUrl);
		content.push({ type: "image_url", image_url: { url: dataUrl } });
	}
	return [{ role: "user", content }];
}

/**
 * 応答が使える形で完結したかを検査し、そうでなければ throw する(呼び出し側の
 * 失敗扱いに載せる)。**「失敗しているのに空の結果を返す」ことを避ける**のが目的。
 *
 * OpenRouter は終了理由を正規化して返す:
 *  - `length`: web検索と reasoning が出力枠を使い切り、JSONが途中で切れている。
 *    パースに回すと「形式が不正」という無関係な例外になり、原因が追えなくなる
 *  - `content_filter`: セーフティ判定で拒否された
 *  - `error`: プロバイダ側のエラー
 *
 * `tool_calls` / `stop` は**正常**として通す。web検索はサーバーツールなので、
 * 検索して終わった応答にも本文が付く。
 */
export function assertGptLabelFinished(finishReason: string): void {
	if (finishReason === "length") {
		throw new Error("GPTの応答が出力上限で打ち切られました(length)");
	}
	if (finishReason === "content_filter") {
		throw new Error("GPTがエチケット解析の応答を拒否しました(content-filter)");
	}
	if (finishReason === "error") {
		throw new Error("GPTの応答がエラーで終了しました(error)");
	}
}
