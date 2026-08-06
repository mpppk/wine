import { jsonSchema, type ModelMessage, Output } from "ai";
import {
	buildWebLabelPrompt,
	LABEL_WEB_JSON_SCHEMA,
	parseImageDataUrl,
} from "./label-extraction";

// エチケット解析の高精度経路(OpenAI GPT-5.6 Luna + web検索)の純ロジック。
// 入力組み立て・出力形式の指定・usage 変換を DB/env 非依存で切り出し、単体テスト可能に
// する(API の実行とクレジット処理・フォールバックは ai-service 側)。
//
// **この経路は AI SDK(`ai` + `@ai-sdk/openai`)で呼ぶ**(#455 の実測で移行を決定)。
// 生の Responses API を直接叩いていた頃との違い:
//  - リクエストは `ModelMessage[]` + `Output.object` で組み立てる。web検索は
//    プロバイダ実行ツールとしてサーバー側でループが完走するのは同じ
//  - usage はプロバイダ横断の共通形で返る(`toAiSdkUsage` が変換する)。
//    web検索の**実行回数は usage に出ない**ので、ツール呼び出しを数えるしかない
//    ($10/1000回 の回数課金なので、数えないと原価の大半が漏れる)
//  - 画像は **`file` パートで渡す**。非推奨の `image` パートはシリアライズが変わって
//    プロンプトキャッシュのプレフィクスが一致せず、実測でコストが約2倍になった(#455)
//
// Claude経路(label-web-research.ts)との違いは APIの形だけで、指示文・出力フィールド・
// マスタのグラウンディングは共有する(buildWebLabelPrompt / LABEL_WEB_JSON_SCHEMA)。
// structured outputs で出力形式を強制できるので、「JSONの前後に説明文を書かせない」ことを
// プロンプトだけに頼らなくて済むのはこちらの強み。

/** structured outputs のスキーマ名(a-zA-Z0-9_- のみ・64文字以内)。 */
export const GPT_LABEL_SCHEMA_NAME = "wine_label_extraction";

/** AI SDK のツール名。計上(回数を数える)と軌跡の抽出が同じ名前を見る。 */
export const GPT_WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * 指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる。
 * Claude経路と同じく1リクエストに全photoを載せ、表ラベルの呼称と裏ラベルの品種を
 * 突き合わせて総合判断させる。
 *
 * 画像は data URI をそのまま渡せるが、**HTTP URL を渡せてしまう**ため
 * parseImageDataUrl を通して data URI であることを強制する(Claude経路と同じ境界)。
 * media type は data URI から取り出したものをそのまま使う。
 */
export function buildGptLabelMessages(imageDataUrls: string[]): ModelMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: buildWebLabelPrompt() },
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
 * structured outputs の指定。**高精度経路用の `LABEL_WEB_JSON_SCHEMA`** を使う
 * (Workers AI 経路の `LABEL_JSON_SCHEMA` にフィールドごとの根拠 `sources` を足したもので、
 * 共通部分は向こうから展開して derive してある)。strict は全項目 required +
 * additionalProperties:false を要求するが、どちらももともとその形なのでそのまま渡せる。
 *
 * **`sources` を strict で強制できるのがこの経路の強み**。Claude経路は同じフィールドを
 * プロンプトでしか要求できないので、書かれないことがある(パース側が欠落に耐える)。
 */
export function buildGptLabelOutput() {
	return Output.object({
		name: GPT_LABEL_SCHEMA_NAME,
		schema: GPT_LABEL_OUTPUT_SCHEMA,
	});
}

/**
 * structured outputs に渡すスキーマ。**`Output.object` の戻り値は内部構造を公開しない**
 * ので、SSOT(`LABEL_WEB_JSON_SCHEMA`)との結び付きをテストで固定できるよう
 * ここで名前を付けて持つ。経路ごとにスキーマを書き分けないための歯止め。
 */
export const GPT_LABEL_OUTPUT_SCHEMA = jsonSchema<Record<string, unknown>>(
	LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>,
);

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
