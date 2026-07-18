import { z } from "zod";
import { AI_MAX_ESTIMATE_TOKENS } from "#/lib/billing/plans";
import {
	GRAPE_VARIETIES,
	getRegion,
	listAops,
	listRegions,
} from "#/lib/wine/service";
import type { Aop } from "#/lib/wine/types";
import {
	AI_LABEL_IMAGE_TOKEN_ESTIMATE,
	AI_LABEL_MAX_OUTPUT_TOKENS,
	CHARS_PER_TOKEN_ESTIMATE,
} from "./config";

// エチケット(ラベル)画像からのマイセラー項目抽出。プロンプト・出力スキーマ・応答パース・
// 静的マスタ(AOP/地域/品種)へのマッチングを DB/env 非依存の純ロジックとして切り出し、
// 単体テスト可能にする(Workers AI の実行とクレジット処理は ai-service 側)。

/**
 * guided_json でモデルに強制する出力スキーマ。ラベルから読み取れない項目は null を
 * 返させる(創作させない)。フィールド名はモデルが解釈しやすい英語 snake_case。
 */
export const LABEL_JSON_SCHEMA = {
	type: "object",
	properties: {
		wine_name: {
			type: ["string", "null"],
			description: "The main wine name printed on the label",
		},
		producer: {
			type: ["string", "null"],
			description:
				"Producer / domaine / chateau / winery name printed on the label",
		},
		vintage: {
			type: ["integer", "null"],
			description: "Vintage year printed on the label (e.g. 2020)",
		},
		appellation: {
			type: ["string", "null"],
			description:
				"Appellation printed on the label (AOC/AOP/DOC/DOCG etc.), e.g. 'Chablis Premier Cru'",
		},
		region: {
			type: ["string", "null"],
			description: "Wine region if identifiable, e.g. 'Bourgogne'",
		},
		grape_varieties: {
			type: "array",
			items: { type: "string" },
			description: "Grape varieties only if printed on the label",
		},
	},
	required: [
		"wine_name",
		"producer",
		"vintage",
		"appellation",
		"region",
		"grape_varieties",
	],
	additionalProperties: false,
} as const;

/** モデルへの指示文。出力形式は guided_json が強制するため、内容の規範だけ書く。 */
export const LABEL_PROMPT = [
	"これらは同一のワイン1本を撮影した写真です(表ラベル・裏ラベル・ボトル全体など複数枚のことがあります)。",
	"すべての写真に印字されている情報を総合して読み取り、1本ぶんの情報としてJSONで出力してください。",
	"- どの写真からも読み取れない項目は null にする。推測で創作しない。",
	"- 複数の写真に異なる記載があれば、より具体的で確度の高い記載を優先する。",
	"- vintage は西暦の整数(例: 2020)。",
	"- appellation はラベル記載の原産地呼称(AOC/AOP/DOC/DOCG など)を原語のまま。",
	"- grape_varieties はいずれかの写真に明記されている場合のみ。",
].join("\n");

/** Workers AI(マルチモーダル)に渡すメッセージのcontent要素。 */
export interface LabelContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

export interface LabelAiMessage {
	role: "user";
	content: LabelContentPart[];
}

/**
 * 指示文 + エチケット画像(data URI)群の1メッセージを組み立てる。
 * 複数枚を1メッセージ内の複数 image_url パートとして渡し、モデルに総合判断させる
 * (Llama 4 Scout は複数画像の content パートを受け付ける)。
 */
export function buildLabelMessages(imageDataUrls: string[]): LabelAiMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: LABEL_PROMPT },
				...imageDataUrls.map(
					(url): LabelContentPart => ({
						type: "image_url",
						image_url: { url },
					}),
				),
			],
		},
	];
}

/** モデル出力(JSON)の受け取り側スキーマ。guided_json 非対応環境へのフォールバックも兼ねて緩めに受ける。 */
const labelResponseSchema = z.object({
	wine_name: z.string().nullish(),
	producer: z.string().nullish(),
	vintage: z.number().int().nullish(),
	appellation: z.string().nullish(),
	region: z.string().nullish(),
	grape_varieties: z.array(z.string()).nullish(),
});

/** モデル出力を正規化した抽出結果。未読取は undefined。 */
export interface LabelExtraction {
	wineName?: string;
	producer?: string;
	vintage?: number;
	appellation?: string;
	region?: string;
	grapeVarieties: string[];
}

/** 空文字・"null"等のプレースホルダを undefined に落とす。 */
function cleanText(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (/^(null|none|unknown|不明)$/i.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * モデルの生出力をパースする。guided_json で JSON が強制される想定だが、
 * コードフェンスや前後の文が混ざるケースに備えて最初の { 〜 最後の } を取り出す。
 * 解釈できない場合は throw(呼び出し側でクレジット返却の上エラー応答にする)。
 */
export function parseLabelResponse(raw: string): LabelExtraction {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) {
		throw new Error("AIの応答にJSONが含まれていません");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error("AIの応答を解釈できませんでした");
	}
	const result = labelResponseSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error("AIの応答の形式が不正です");
	}
	const d = result.data;
	return {
		wineName: cleanText(d.wine_name),
		producer: cleanText(d.producer),
		vintage: d.vintage ?? undefined,
		appellation: cleanText(d.appellation),
		region: cleanText(d.region),
		grapeVarieties: (d.grape_varieties ?? [])
			.map((g) => g.trim())
			.filter((g) => g.length > 0),
	};
}

/**
 * マスタ照合用の正規化。アクセント記号を落とし(é→e)、小文字化し、記号・中点等を
 * スペースに畳む。日本語(かな・カナ・漢字)はそのまま残すので nameJa とも比較できる。
 */
export function normalizeLabelText(text: string): string {
	return (
		text
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			// 中点(U+30FB)はカタカナブロック内にあり下の許可クラスに残るため、先に区切り化する
			.replace(/・/g, " ")
			.replace(/[^a-z0-9぀-ヿ一-鿿]+/gu, " ")
			.trim()
			.replace(/\s+/g, " ")
			// NFKDで分解されたままの濁点・半濁点(U+3099/309A)を合成形に戻す
			.normalize("NFC")
	);
}

/** 誤爆を避けるための最小一致長(正規化後)。"Ay" のような極短名の含有一致を禁止する。 */
const AOP_MATCH_MIN_CHARS = 4;

/**
 * 呼称・ワイン名のテキスト群からAOPを1つ解決する。AOP名(正式名・短縮名・日本語名)の
 * 正規化形がテキストと完全一致するか、テキスト中に単語境界つきで含まれるものを探し、
 * より長い(=より具体的な)名前の一致を優先する
 * (例: "Chablis Premier Cru" は Chablis ではなく Chablis Premier Cru に解決)。
 */
export function matchAop(texts: string[]): Aop | undefined {
	let best: { aop: Aop; length: number } | undefined;
	for (const rawText of texts) {
		const text = normalizeLabelText(rawText);
		if (text.length < AOP_MATCH_MIN_CHARS) continue;
		for (const aop of listAops()) {
			for (const label of [aop.name, aop.shortName, aop.nameJa]) {
				const normalized = normalizeLabelText(label);
				if (normalized.length < AOP_MATCH_MIN_CHARS) continue;
				if (!` ${text} `.includes(` ${normalized} `)) continue;
				if (!best || normalized.length > best.length) {
					best = { aop, length: normalized.length };
				}
			}
		}
	}
	return best?.aop;
}

/** 英語名など、地域マスタの表記(id/現地語/日本語)に無い別名の対応表(正規化形)。 */
const REGION_ALIASES: Record<string, string> = {
	burgundy: "bourgogne",
	piedmont: "piemonte",
	"loire valley": "loire",
	"val de loire": "loire",
};

/** 地域テキスト群から enabled な地域の id を解決する。 */
export function matchRegionId(texts: string[]): string | undefined {
	const regions = listRegions().filter((r) => r.enabled);
	for (const rawText of texts) {
		const text = normalizeLabelText(rawText);
		if (!text) continue;
		const aliased = REGION_ALIASES[text] ?? text;
		for (const region of regions) {
			const labels = [region.id, region.nameLocal, region.nameJa];
			if (labels.some((l) => normalizeLabelText(l) === aliased)) {
				return region.id;
			}
		}
	}
	return undefined;
}

/** 品種名テキスト群を品種マスタの id へ解決する(一致しないものは落とす)。 */
export function matchGrapeVarietyIds(names: string[]): string[] {
	const ids: string[] = [];
	for (const rawName of names) {
		const text = normalizeLabelText(rawName);
		if (!text) continue;
		const hit = GRAPE_VARIETIES.find((v) =>
			[v.id, v.nameLocal, v.nameJa].some((l) => normalizeLabelText(l) === text),
		);
		if (hit && !ids.includes(hit.id)) ids.push(hit.id);
	}
	return ids;
}

/** フォームへ流し込める形の自動入力候補。キーは drunkWineFields と揃える。 */
export interface LabelSuggestions {
	name?: string;
	producer?: string;
	vintage?: number;
	/** フォームのAOP絞り込み用(AOPが解決できた場合はその地域)。 */
	regionId?: string;
	aopId?: string;
	grapeVarietyIds?: string[];
}

/**
 * 抽出結果をマスタと突合し、フォームの自動入力候補に変換する。
 * - AOPは呼称→ワイン名の順で解決し、解決できたら地域もAOPから導出する。
 * - 名前(必須項目)はワイン名が読めなければAOP日本語名→呼称の原文で補う。
 * - 品種はラベル記載を優先。無記載でもAOPの主要品種(principal)が1種だけなら
 *   それを候補にする(シャブリ=シャルドネ等、呼称が品種を規定するケース)。
 * - vintage はフォームと同じ 1800〜2100 の範囲外を捨てる。
 */
export function buildLabelSuggestions(
	extraction: LabelExtraction,
): LabelSuggestions {
	const suggestions: LabelSuggestions = {};
	if (extraction.wineName) suggestions.name = extraction.wineName.slice(0, 200);
	if (extraction.producer) {
		suggestions.producer = extraction.producer.slice(0, 200);
	}
	if (
		extraction.vintage != null &&
		extraction.vintage >= 1800 &&
		extraction.vintage <= 2100
	) {
		suggestions.vintage = extraction.vintage;
	}

	const aopTexts = [extraction.appellation, extraction.wineName].filter(
		(t): t is string => !!t,
	);
	const aop = matchAop(aopTexts);
	if (aop && getRegion(aop.region)?.enabled) {
		suggestions.aopId = aop.id;
		suggestions.regionId = aop.region;
	} else {
		const regionTexts = [extraction.region, extraction.appellation].filter(
			(t): t is string => !!t,
		);
		const regionId = matchRegionId(regionTexts);
		if (regionId) suggestions.regionId = regionId;
	}

	// キュヴェ名等が無いラベルでは wine_name が null になりやすい。名前は唯一の必須
	// 項目なので、AOPの日本語名(→呼称の原文)で補って保存までの手数を減らす
	// (プレースホルダ「例: シャブリ プルミエ・クリュ」と同じ流儀)。
	if (!suggestions.name) {
		if (suggestions.aopId && aop) {
			suggestions.name = aop.nameJa;
		} else if (extraction.appellation) {
			suggestions.name = extraction.appellation.slice(0, 200);
		}
	}

	let grapeIds = matchGrapeVarietyIds(extraction.grapeVarieties);
	if (grapeIds.length === 0 && aop) {
		const principals = aop.grapes
			.filter((g) => g.role === "principal")
			.map((g) => g.varietyId);
		if (principals.length === 1 && principals[0]) grapeIds = [principals[0]];
	}
	if (grapeIds.length > 0) suggestions.grapeVarietyIds = grapeIds;

	return suggestions;
}

/**
 * 予約すべきトークン数の見積。画像の見積が支配的なので枚数に比例させ、指示文の推定 +
 * 出力上限を足し、上限で必ずクランプする(予約が実測を上回るよう保守的に)。
 * imageCount は1以上を想定(0でも下限は指示文+出力ぶんになる)。
 */
export function estimateLabelReserveTokens(imageCount: number): number {
	const promptTokens = Math.ceil(
		LABEL_PROMPT.length / CHARS_PER_TOKEN_ESTIMATE,
	);
	return Math.min(
		AI_MAX_ESTIMATE_TOKENS,
		AI_LABEL_IMAGE_TOKEN_ESTIMATE * Math.max(1, imageCount) +
			promptTokens +
			AI_LABEL_MAX_OUTPUT_TOKENS,
	);
}
