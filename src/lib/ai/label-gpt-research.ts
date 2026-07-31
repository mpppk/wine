import type OpenAI from "openai";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	AI_LABEL_GPT_BASE_TOKEN_ESTIMATE,
	AI_LABEL_GPT_IMAGE_TOKEN_ESTIMATE,
} from "./config";
import {
	buildWebLabelPrompt,
	LABEL_JSON_SCHEMA,
	parseImageDataUrl,
} from "./label-extraction";

// エチケット解析の高精度経路(OpenAI GPT-5.6 Luna + web検索)の純ロジック。
// 入力組み立て・出力の取り出し・見積を DB/env 非依存で切り出し、単体テスト可能にする
// (OpenAI API の実行とクレジット処理・フォールバックは ai-service 側)。
//
// Claude経路(label-web-research.ts)との違いは**APIの形だけ**で、指示文・出力フィールド・
// マスタのグラウンディングは共有する(buildWebLabelPrompt / LABEL_JSON_SCHEMA):
//  - Responses API を使う(web_search ツールが使えるのはこちら)。ツールループは
//    サーバー側で完走するため、Claude経路の pause_turn 継続ループに相当する処理は要らない。
//  - structured outputs(text.format = json_schema)で出力形式を強制できるので、
//    「JSONの前後に説明文を書かせない」ことをプロンプトだけに頼らなくて済む。
//  - usage.total_tokens が入力(キャッシュ含む)+ 出力(reasoning 含む)の総和なので、
//    Claude経路の sumAnthropicUsage のような内訳の足し合わせが要らない。

/** structured outputs のスキーマ名(a-zA-Z0-9_- のみ・64文字以内)。 */
export const GPT_LABEL_SCHEMA_NAME = "wine_label_extraction";

/**
 * 指示文 + 全エチケット画像を1つのユーザーメッセージに組み立てる。
 * Claude経路と同じく1リクエストに全photoを載せ、表ラベルの呼称と裏ラベルの品種を
 * 突き合わせて総合判断させる。
 *
 * 画像は data URI をそのまま image_url に渡せるが、**HTTP URL を渡せてしまう**ため
 * parseImageDataUrl を通して data URI であることを強制する(Claude経路と同じ境界)。
 * detail は "auto" に任せる(クライアントが長辺1280pxへ縮小済み)。
 */
export function buildGptLabelInput(
	imageDataUrls: string[],
): OpenAI.Responses.ResponseInput {
	const content: OpenAI.Responses.ResponseInputMessageContentList = [
		{ type: "input_text", text: buildWebLabelPrompt() },
	];
	for (const dataUrl of imageDataUrls) {
		// 戻り値は使わないが、data URI でなければここで throw する(境界の強制)
		parseImageDataUrl(dataUrl);
		content.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
	}
	return [{ role: "user", content }];
}

/**
 * structured outputs の指定。Workers AI 経路の guided_json と同じ LABEL_JSON_SCHEMA を
 * 使う(出力フィールドの SSOT)。strict は全項目 required + additionalProperties:false を
 * 要求するが、LABEL_JSON_SCHEMA はもともとその形なのでそのまま渡せる。
 */
export function buildGptLabelTextFormat(): OpenAI.Responses.ResponseTextConfig {
	return {
		format: {
			type: "json_schema",
			name: GPT_LABEL_SCHEMA_NAME,
			schema: LABEL_JSON_SCHEMA as unknown as Record<string, unknown>,
			strict: true,
		},
	};
}

/**
 * 応答から本文JSONの文字列を取り出す。**「失敗しているのに空文字を返す」ことを避ける**のが
 * この関数の主目的で、以下は throw して呼び出し側のフォールバックに載せる:
 *  - status="incomplete": web検索と reasoning が出力枠を使い切り、JSONが途中で切れている。
 *    パースに回すと「形式が不正」という無関係な例外になり、原因が追えなくなる。
 *  - refusal ブロック: セーフティ判定で拒否された(structured outputs でもスキーマには従わない)。
 *
 * @see https://developers.openai.com/api/docs/guides/structured-outputs
 */
export function extractGptLabelText(response: {
	status?: string | null;
	incomplete_details?: { reason?: string | null } | null;
	output_text?: string;
	/**
	 * output の要素はツール呼び出し・reasoning・メッセージが混在する判別共用体で、
	 * content を持たない要素もある。ここで欲しいのは refusal ブロックの有無だけなので
	 * unknown で受けて findRefusal 側で絞り込む(SDKの型に構造を合わせにいくと、
	 * 判別共用体が増えるたびにテスト用のダミー値が組み立てられなくなる)。
	 */
	output?: readonly unknown[];
}): string {
	if (response.status === "incomplete") {
		const reason = response.incomplete_details?.reason ?? "unknown";
		throw new Error(`GPTの応答が途中で打ち切られました(${reason})`);
	}
	const refusal = findRefusal(response.output);
	if (refusal) {
		throw new Error(`GPTがエチケット解析の応答を拒否しました: ${refusal}`);
	}
	return response.output_text ?? "";
}

/** output の任意の階層に含まれる refusal ブロックの説明文を1つ返す。無ければ undefined。 */
function findRefusal(
	output: readonly unknown[] | undefined,
): string | undefined {
	for (const item of output ?? []) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const { type, refusal } = block as { type?: unknown; refusal?: unknown };
			if (type === "refusal" && typeof refusal === "string") return refusal;
		}
	}
	return undefined;
}

/**
 * GPT経路の予約トークン見積。web検索結果・reasoning が支配的で事前に読めないため、
 * 基礎値を大きめに取り settle の実測(usage.total_tokens)で差分を返す。上限で必ず
 * クランプする(Claude経路の estimateWebLabelReserveTokens と同じ流儀)。
 */
export function estimateGptLabelReserveTokens(imageCount: number): number {
	return Math.min(
		AI_MAX_ESTIMATE_TOKENS,
		AI_LABEL_GPT_BASE_TOKEN_ESTIMATE +
			AI_LABEL_GPT_IMAGE_TOKEN_ESTIMATE * Math.max(1, imageCount),
	);
}
