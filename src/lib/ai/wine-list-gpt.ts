import type OpenAI from "openai";
import { BadRequestError } from "#/lib/errors";
import {
	LABEL_JSON_SCHEMA,
	type LabelFieldKey,
	parseImageDataUrl,
} from "./label-extraction";
import { findGptRefusal } from "./label-gpt-research";
import {
	buildWineListPrompt,
	WINE_LIST_TRUNCATED_ERROR_MESSAGE,
} from "./wine-list-extraction";

// 一括抽出(Issue #358)の GPT 経路(#426)の純ロジック。入力組み立てと structured
// outputs のスキーマを DB/env 非依存で切り出し、単体テスト可能にする(OpenAI API の
// 実行とクレジット処理は ai-service 側)。
//
// Claude 経路(wine-list-extraction.ts の buildWineListMessages)との違いは**APIの形と
// 出力形式の強制手段だけ**で、指示文・マスタのグラウンディング・応答のパースは共有する
// (label-gpt-research.ts が label-web-research.ts と buildWebLabelPrompt を共有するのと
// 同じ形)。ここで指示文を書き直すと、片方の経路だけ「price を読ませ忘れる」といった
// 差が生まれる。
//
// **structured outputs が使えるのがこの経路の強み**。銘柄配列は形が壊れると全滅する
// 出力だが、Claude 経路はそれを指示文でしか担保できない(wine-list-extraction.ts の
// buildWineListPrompt のコメント参照)。

/** structured outputs のスキーマ名(a-zA-Z0-9_- のみ・64文字以内)。 */
export const GPT_WINE_LIST_SCHEMA_NAME = "wine_list_extraction";

/**
 * 銘柄1件のスキーマ。**エチケット解析の `LABEL_JSON_SCHEMA` から展開して derive する**
 * ので、抽出フィールドを足したときにこちらだけ古くなることがない(一括抽出に固有の
 * `price` / `photo_indexes` だけを足す形)。
 *
 * strict は全 properties が required + `additionalProperties: false` を要求するため、
 * 「記載が無い」は省略ではなく `null` で表す。
 */
const WINE_LIST_ITEM_SCHEMA = {
	type: "object",
	properties: {
		...LABEL_JSON_SCHEMA.properties,
		price: {
			type: ["integer", "null"],
			description:
				"Price in Japanese yen as printed in the list. Use the bottle price when both glass and bottle are listed. null if not printed",
		},
		photo_indexes: {
			type: "array",
			items: { type: "integer" },
			description:
				"Zero-based indexes of the photos this wine appears in (the number written just before each image)",
		},
	},
	required: [...LABEL_JSON_SCHEMA.required, "price", "photo_indexes"],
	additionalProperties: false,
} as const satisfies {
	type: "object";
	properties: Record<string, unknown>;
	required: readonly (LabelFieldKey | "price" | "photo_indexes")[];
	additionalProperties: false;
};

/**
 * 一括抽出の出力スキーマ。項目の意味と JSON の形は `buildWineListPrompt` が書いている
 * 規範と一対一に対応させる(指示文とスキーマが食い違うと、モデルはスキーマに従いつつ
 * 中身の解釈だけ指示文に引きずられる)。
 */
export const WINE_LIST_JSON_SCHEMA = {
	type: "object",
	properties: {
		wines: {
			type: "array",
			items: WINE_LIST_ITEM_SCHEMA,
			description:
				"All wines readable in the photos, with duplicates across photos merged into one entry",
		},
		subject: {
			type: "string",
			enum: ["single_wine", "wine_list"],
			description:
				"single_wine = every photo shows the same single bottle/label; wine_list = a restaurant list, shop shelf, or multiple wines",
		},
		truncated: {
			type: "boolean",
			description: "true if some wines had to be left out of the output",
		},
	},
	required: ["wines", "subject", "truncated"],
	additionalProperties: false,
} as const;

/**
 * 指示文 + 全写真を1つのユーザーメッセージに組み立てる。**写真ごとに直前へ
 * 「写真 N」のテキストブロックを挟む**のは Claude 経路と同じで、これが無いとモデルは
 * photo_indexes を当て推量で埋める(どの写真で見かけたか = 目撃記録の由来が壊れる)。
 *
 * data URI であることの強制は parseImageDataUrl が兼ねる(image_url には HTTP URL も
 * 渡せてしまうため。エチケット解析の GPT 経路と同じ境界)。detail は "auto" に任せる
 * (クライアントが長辺1600pxへ縮小済み)。
 */
export function buildWineListGptInput(
	imageDataUrls: string[],
): OpenAI.Responses.ResponseInput {
	const content: OpenAI.Responses.ResponseInputMessageContentList = [
		{ type: "input_text", text: buildWineListPrompt(imageDataUrls.length) },
	];
	for (const [index, dataUrl] of imageDataUrls.entries()) {
		// 戻り値は使わないが、data URI でなければここで throw する(境界の強制)
		parseImageDataUrl(dataUrl);
		content.push({ type: "input_text", text: `写真 ${index}` });
		content.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
	}
	return [{ role: "user", content }];
}

/** structured outputs の指定(strict)。 */
export function buildWineListGptTextFormat(): OpenAI.Responses.ResponseTextConfig {
	return {
		format: {
			type: "json_schema",
			name: GPT_WINE_LIST_SCHEMA_NAME,
			schema: WINE_LIST_JSON_SCHEMA as unknown as Record<string, unknown>,
			strict: true,
		},
	};
}

/**
 * 応答から本文JSONの文字列を取り出す。**「失敗しているのに空文字を返す」ことを避ける**のが
 * この関数の主目的(エチケット解析の `extractGptLabelText` と同じ役割)だが、
 * **打ち切りの扱いだけが違う**:
 *
 * 一括抽出の出力は銘柄数に比例して伸びるので、`max_output_tokens` での打ち切りは
 * 「モデルの調子が悪い」ではなく「写真に写っているワインが多すぎる」であり、
 * ユーザには次の行動(写真を分ける)がある。Claude 経路が `stop_reason="max_tokens"` を
 * `BadRequestError` に変えているのと同じ扱いに揃える(同じ文言 = 同じ escape hatch)。
 * それ以外の理由(content_filter 等)はユーザが行動できないので素の Error にする。
 */
export function extractWineListGptText(response: {
	status?: string | null;
	incomplete_details?: { reason?: string | null } | null;
	output_text?: string;
	/** refusal ブロックの有無だけを見る(判別共用体に構造を合わせにいかない)。 */
	output?: readonly unknown[];
}): string {
	if (response.status === "incomplete") {
		const reason = response.incomplete_details?.reason ?? "unknown";
		if (reason === "max_output_tokens") {
			throw new BadRequestError(WINE_LIST_TRUNCATED_ERROR_MESSAGE);
		}
		throw new Error(`GPTの応答が途中で打ち切られました(${reason})`);
	}
	const refusal = findGptRefusal(response.output);
	if (refusal) {
		throw new Error(`GPTがワインリストの解析の応答を拒否しました: ${refusal}`);
	}
	return response.output_text ?? "";
}
