import type { ModelMessage } from "ai";
import { buildAgentLabelPrompt, parseImageDataUrl } from "./label-extraction";

// エチケット解析の高精度経路(OpenAI GPT-5.6 Luna + web検索)の純ロジック。
// 入力組み立て・usage 変換を DB/env 非依存で切り出し、単体テスト可能に
// する(API の実行とクレジット処理・フォールバックは ai-service 側)。
//
// **この経路は AI SDK(`ai` + `@ai-sdk/openai`)で呼ぶ**(#455 の実測で移行を決定)。
// エージェントループ化(#458)以降は `generateText` + ツール群で収束させる:
//  - リクエストは `ModelMessage[]` + ツール群(`web_search` + `submit_answer` 等)で組み立てる。
//    web検索はプロバイダ実行ツールとしてサーバー側でループが完走するのは同じ
//  - 回答は `submit_answer` の呼び出しでのみ受け取る。本文にJSONを書かせない
//    (`buildAgentLabelPrompt` が `buildWebLabelPrompt` の「JSONだけを出力」指示を持たないのはこのため)
//  - usage はプロバイダ横断の共通形で返る(`toAiSdkUsage` が変換する)。
//    web検索の**実行回数は usage に出ない**ので、ツール呼び出しを数えるしかない
//    ($10/1000回 の回数課金なので、数えないと原価の大半が漏れる)
//  - 画像は **`file` パートで渡す**。非推奨の `image` パートはシリアライズが変わって
//    プロンプトキャッシュのプレフィクスが一致せず、実測でコストが約2倍になった(#455)
//
// Claude経路(label-web-research.ts)は1リクエスト完結で `buildWebLabelPrompt` を使うが、
// GPT経路はエージェントループで `buildAgentLabelPrompt` を使う。裏取りの規範と出力フィールドの
// 定義は共有している(SSOT)。違うのは「1回で出し切る」か「ツールを使って収束させる」かという進め方だけ。

/** AI SDK のツール名。計上(回数を数える)と軌跡の抽出が同じ名前を見る。 */
export const GPT_WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * エージェントループ用の指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる。
 * 1リクエストに全photoを載せ、表ラベルの呼称と裏ラベルの品種を突き合わせて総合判断させる。
 *
 * 画像は data URI をそのまま渡せるが、**HTTP URL を渡せてしまう**ため
 * parseImageDataUrl を通して data URI であることを強制する(Claude経路と同じ境界)。
 * media type は data URI から取り出したものをそのまま使う。
 *
 * 指示文は差し替え可能にする(`buildWebLabelMessages` の promptText と同じ理由)。
 */
export function buildGptLabelMessages(
	imageDataUrls: string[],
	promptText: string = buildAgentLabelPrompt(),
): ModelMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: promptText },
				...imageDataUrls.map((dataUrl) => ({
					type: "file" as const,
					// data URI でなければここで throw する(境界の強制)
					mediaType: parseImageDataUrl(dataUrl).mediaType,
					data: dataUrl,
				})),
			],
		},
	];
}

/**
 * 応答が使える形で完結したかを検査し、そうでなければ throw する(呼び出し側の
 * フォールバックに載せる)。**「失敗しているのに空の結果を返す」ことを避ける**のが目的。
 *
 * AI SDK は打ち切りや拒否を `finishReason` に畳んで返す:
 *  - `length`: web検索と reasoning が出力枠を使い切り、JSONが途中で切れている。
 *    パースに回すと「形式が不正」という無関係な例外になり、原因が追えなくなる
 *  - `content-filter`: セーフティ判定で拒否された(structured outputs でもスキーマに従わない)
 *  - `error`: プロバイダ側のエラー
 *
 * `tool-calls` は**正常**として通す。web検索はプロバイダ実行ツールなので、ツール呼び出しで
 * 終わった応答にも本文が付く。
 */
export function assertGptLabelFinished(finishReason: string): void {
	if (finishReason === "length") {
		throw new Error("GPTの応答が出力上限で打ち切られました(length)");
	}
	if (finishReason === "content-filter") {
		throw new Error("GPTがエチケット解析の応答を拒否しました(content-filter)");
	}
	if (finishReason === "error") {
		throw new Error("GPTの応答がエラーで終了しました(error)");
	}
}
