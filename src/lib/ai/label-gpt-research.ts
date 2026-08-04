import type OpenAI from "openai";
import type { AiUsage } from "#/lib/billing/ai-pricing";
import {
	buildWebLabelPrompt,
	LABEL_WEB_JSON_SCHEMA,
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
//  - usage は input/output に分かれ、キャッシュヒットは input_tokens_details.cached_tokens
//    として内数で返る(Claude のように別項目で足すのではない)。
//  - web検索の**実行回数は usage に出ない**。output 配列の web_search_call アイテムを
//    数えるしかない($10/1000回 の回数課金なので、数えないと原価の大半が漏れる)。

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
 * structured outputs の指定。**高精度経路用の `LABEL_WEB_JSON_SCHEMA`** を使う
 * (Workers AI 経路の `LABEL_JSON_SCHEMA` にフィールドごとの根拠 `sources` を足したもので、
 * 共通部分は向こうから展開して derive してある)。strict は全項目 required +
 * additionalProperties:false を要求するが、どちらももともとその形なのでそのまま渡せる。
 *
 * **`sources` を strict で強制できるのがこの経路の強み**。Claude経路は同じフィールドを
 * プロンプトでしか要求できないので、書かれないことがある(パース側が欠落に耐える)。
 */
export function buildGptLabelTextFormat(): OpenAI.Responses.ResponseTextConfig {
	return {
		format: {
			type: "json_schema",
			name: GPT_LABEL_SCHEMA_NAME,
			schema: LABEL_WEB_JSON_SCHEMA as unknown as Record<string, unknown>,
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
	const refusal = findGptRefusal(response.output);
	if (refusal) {
		throw new Error(`GPTがエチケット解析の応答を拒否しました: ${refusal}`);
	}
	return response.output_text ?? "";
}

/**
 * output の任意の階層に含まれる refusal ブロックの説明文を1つ返す。無ければ undefined。
 * 一括抽出の GPT 経路(wine-list-gpt.ts)も同じ判定を使う——refusal の入れ子の形は
 * Responses API 共通で、経路ごとに書くとどちらかが取りこぼす。
 */
export function findGptRefusal(
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
 * output 配列に含まれる web検索の実行回数を数える。
 *
 * **usage には出てこない**ため、ここで数えないと $10/1000回 の回数課金がまったく
 * 計上されない。Luna は原価の8割が web検索なので、漏らすと経路の原価がほぼ見えなくなる。
 */
export function countGptWebSearches(
	output: readonly unknown[] | undefined,
): number {
	let count = 0;
	for (const item of output ?? []) {
		if (!item || typeof item !== "object") continue;
		if ((item as { type?: unknown }).type === "web_search_call") count++;
	}
	return count;
}

/**
 * OpenAI Responses API の usage をクレジット計上用の `AiUsage` へ変換する。
 *
 * `input_tokens` は**キャッシュヒットを内数として含む**ため、`cached_tokens` を
 * 差し引いてから非キャッシュ入力として計上する(二重計上を避ける)。web検索回数だけは
 * usage に無いので呼び出し側が `countGptWebSearches` の結果を渡す。
 */
export function toGptUsage(
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				input_tokens_details?: { cached_tokens?: number | null } | null;
		  }
		| undefined,
	webSearches: number,
): AiUsage {
	const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
	const input = usage?.input_tokens ?? 0;
	return {
		inputTokens: Math.max(0, input - cached),
		outputTokens: usage?.output_tokens ?? 0,
		cacheReadTokens: cached,
		webSearches,
	};
}
