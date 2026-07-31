import type Anthropic from "@anthropic-ai/sdk";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import { GRAPE_VARIETIES, listAops } from "#/lib/wine/service";
import {
	AI_LABEL_WEB_BASE_TOKEN_ESTIMATE,
	AI_LABEL_WEB_IMAGE_TOKEN_ESTIMATE,
} from "./config";

// エチケット解析の高精度経路(Anthropic Claude + web検索)の純ロジック。
// プロンプト・メッセージ組み立て・見積を DB/env 非依存で切り出し、単体テスト可能にする
// (Anthropic API の実行とクレジット処理・フォールバックは ai-service 側)。
//
// Workers AI 経路(label-extraction.ts)との違い:
//  - 全写真を1リクエストに載せ、表・裏ラベルを突き合わせて総合判断させる
//  - web検索で生産者公式サイト・ワインDBを裏取りし、綴りの修正・呼称の特定・
//    ラベル未記載のセパージュの補完まで行わせる
//  - 出力の呼称・品種はアプリのマスタ表記に寄せさせ、matchAop / matchGrapeVarietyIds
//    のヒット率を上げる(マスタ名の一覧をプロンプトに同梱する)

/** data URI を Anthropic の image ブロック入力(base64 + media type)に分解する。 */
export function parseImageDataUrl(dataUrl: string): {
	mediaType: string;
	data: string;
} {
	const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl);
	const mediaType = match?.[1];
	const data = match?.[2];
	if (!mediaType || !data) {
		throw new Error("画像のdata URIを解釈できませんでした");
	}
	return { mediaType, data };
}

/**
 * マスタ名の一覧をプロンプト用に整形する。呼称は正式名(name)を使う
 * (matchAop は name / shortName / nameJa のいずれでも一致するが、
 * ラベル・検索結果の表記に最も近いのは正式名)。
 */
function buildKnownListsSection(): string {
	const aopNames = listAops().map((a) => a.name);
	const grapeNames = GRAPE_VARIETIES.map((v) => v.nameLocal);
	return [
		"## 既知の原産地呼称リスト(該当があればこの表記を一字一句そのまま使う)",
		aopNames.join(" / "),
		"",
		"## 既知の品種リスト(該当があればこの表記を使う)",
		grapeNames.join(" / "),
	].join("\n");
}

/**
 * Claude への指示文。読み取り→web検索での裏取り→JSON出力の手順を規定する。
 * 出力フィールドは Workers AI 経路(LABEL_JSON_SCHEMA)と同じキーにし、
 * 応答パースを parseLabelResponse で共通化する。
 */
export function buildWebLabelPrompt(): string {
	return [
		"これはワインのボトル/エチケット(ラベル)の写真です(同一ボトルの表・裏ラベルなど複数枚のことがあります)。",
		"以下の手順でこのワインの情報を特定し、最後にJSONオブジェクトだけを出力してください。",
		"",
		"1. 全ての写真からワイン名・生産者・ヴィンテージ・原産地呼称・地域・品種を読み取る。",
		"2. web検索で裏取りする。生産者の公式サイト、Wine-Searcher・Vivino等のワインデータベース、輸入元の商品ページ、原産地呼称の公式情報を優先して参照する。",
		"   - 生産者名・ワイン名の綴りを正式表記に正す(写真の読み取り誤りを修正する)。",
		"   - 原産地呼称はラベルに明記されていなくても、このワインの正式なAOC/AOP/DOC/DOCG等を特定する。",
		"   - 品種はラベルに無記載でも、生産者情報・ワインデータベースで確認できたセパージュを列挙する(推測は不可。検索で確認できた場合のみ)。",
		"   - ヴィンテージは写真から読めた値を最優先する。写真から読めない場合は null にする(検索結果から創作しない)。",
		"3. 出力するJSONのフィールド:",
		'   - "wine_name": キュヴェ名等を含む正式なワイン名(原語)。無ければ null',
		'   - "producer": 生産者/ドメーヌ/シャトー名(原語の正式表記)。無ければ null',
		'   - "vintage": 西暦の整数(例: 2020)。不明なら null',
		'   - "appellation": 正式な原産地呼称(原語)。不明なら null',
		'   - "region": 地域名(例: Bourgogne, Bordeaux, Toscana)。不明なら null',
		'   - "grape_varieties": 品種名(原語)の文字列配列。確認できなければ空配列',
		"4. 検索しても確認できない項目は null にする。JSONの前後に説明文・コードフェンスを書かない。",
		"",
		buildKnownListsSection(),
	].join("\n");
}

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
