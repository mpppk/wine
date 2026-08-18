import { z } from "zod";
import { buildWineNote } from "#/lib/drunk-wine/note";
import { WINE_COUNTRIES } from "#/lib/wine/countries";
import { findProducerInfoByName } from "#/lib/wine/producer-info";
import {
	GRAPE_VARIETIES,
	getRegion,
	listAops,
	listRegions,
} from "#/lib/wine/service";
import { normalizeLabelText } from "#/lib/wine/text-normalize";
import type { Aop } from "#/lib/wine/types";
import { CHARS_PER_TOKEN_ESTIMATE } from "./config";

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
		country: {
			type: ["string", "null"],
			description: "Country of origin if identifiable, e.g. 'France'",
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
		"country",
		"grape_varieties",
	],
	additionalProperties: false,
} as const;

/** 抽出フィールドのキー。根拠(sources)のキーと1対1にするため LABEL_JSON_SCHEMA から導出する。 */
export type LabelFieldKey = (typeof LABEL_JSON_SCHEMA.required)[number];

/** フィールド値の出どころ。 */
type LabelFieldOrigin = "photo" | "web" | "photo_and_web" | "unknown";

const LABEL_FIELD_ORIGINS: readonly LabelFieldOrigin[] = [
	"photo",
	"web",
	"photo_and_web",
	"unknown",
];

/**
 * 1フィールドぶんの根拠スキーマ。strict な structured outputs は全項目 required +
 * additionalProperties:false を要求するので、`url` は省略可能にせず `null` 許容にする。
 */
const LABEL_FIELD_SOURCE_SCHEMA = {
	type: "object",
	properties: {
		origin: {
			type: "string",
			enum: LABEL_FIELD_ORIGINS,
			description:
				"photo = read from the photo, web = filled in from web search, photo_and_web = read from the photo and verified/corrected by web search, unknown = could not be determined",
		},
		url: {
			type: ["string", "null"],
			description:
				"URL of the page actually used as evidence when origin involves web. null otherwise. Never invent a URL.",
		},
	},
	required: ["origin", "url"],
	additionalProperties: false,
} as const;

/**
 * 根拠オブジェクトの properties。**本体フィールドのキーから derive する**ので、
 * 抽出フィールドを足したときに根拠側だけ古くなることがない。
 */
const LABEL_FIELD_SOURCE_PROPERTIES = Object.fromEntries(
	LABEL_JSON_SCHEMA.required.map((key) => [key, LABEL_FIELD_SOURCE_SCHEMA]),
) as Record<LabelFieldKey, typeof LABEL_FIELD_SOURCE_SCHEMA>;

/**
 * 銘柄のコメント(#471)のフィールド。**高精度経路だけが出す**。
 *
 * `LABEL_JSON_SCHEMA`(Workers AI 経路)には足さない。あちらは裏取りをしないので
 * 「web検索で見つかった表現を踏まえた」コメントを書きようがなく、書かせれば創作に
 * なるだけで、出力上限(512トークン)を本体JSONと奪い合うことになる。
 */
const LABEL_COMMENT_JSON_PROPERTIES = {
	tasting_comment: {
		type: ["string", "null"],
		description:
			"Aroma and flavour of this wine in Japanese (2-3 sentences), grounded in tasting notes found via web search. null if nothing was found.",
	},
	producer_comment: {
		type: ["string", "null"],
		description:
			"Short description of the producer in Japanese (1-2 sentences). null if unknown.",
	},
} as const;

/** コメントフィールドのキー。スキーマの required と受け取り側を1箇所から導出する。 */
const LABEL_COMMENT_KEYS = Object.keys(
	LABEL_COMMENT_JSON_PROPERTIES,
) as (keyof typeof LABEL_COMMENT_JSON_PROPERTIES)[];

/**
 * 高精度経路(LLM + web検索)の出力スキーマ。`LABEL_JSON_SCHEMA` に**フィールドごとの
 * 根拠(`sources`)とコメント(#471)を足したもの**で、GPT経路の structured outputs に渡す。
 *
 * **Workers AI 経路の `LABEL_JSON_SCHEMA` は変えない**のが要点。あちらは
 * `guided_json` で Llama 4 Scout に形を強制する経路だが、guided_json は完全には
 * 効かず(型の揺れは `labelExtractionShape` が吸収している)、出力上限も 512 トークンと
 * 狭い。7フィールドぶんの根拠オブジェクトを足すと、裏取りをしないので `origin` が
 * 常に "photo" になる情報量ゼロの出力のために、本体JSONが枠から溢れる危険だけが増える。
 *
 * 共通部分は `LABEL_JSON_SCHEMA` から展開して derive する(フィールドを足したときに
 * 片方だけ古くなるのを防ぐ)。
 */
export const LABEL_WEB_JSON_SCHEMA = {
	type: "object",
	properties: {
		...LABEL_JSON_SCHEMA.properties,
		...LABEL_COMMENT_JSON_PROPERTIES,
		sources: {
			type: "object",
			description:
				"Evidence for each extracted field: where the value came from and which page backs it",
			properties: LABEL_FIELD_SOURCE_PROPERTIES,
			required: [...LABEL_JSON_SCHEMA.required],
			additionalProperties: false,
		},
	},
	required: [...LABEL_JSON_SCHEMA.required, ...LABEL_COMMENT_KEYS, "sources"],
	additionalProperties: false,
} as const;

/**
 * マスタ名の一覧をプロンプト用に整形する(呼称は正式名 name、品種は現地語名)。
 * モデルの出力表記をマスタへ寄せ、matchAop / matchGrapeVarietyIds のヒット率を
 * 上げるグラウンディング。Workers AI 経路(LABEL_PROMPT)と Claude + web検索経路
 * (label-web-research.ts)の両方がこれを同梱する(SSOT)。
 */
export function buildKnownListsSection(): string {
	const aopNames = listAops().map((a) => a.name);
	return [
		"## 既知の原産地呼称リスト(該当があればこの表記を一字一句そのまま使う)",
		aopNames.join(" / "),
		"",
		buildKnownGrapesSection(),
	].join("\n");
}

/**
 * 品種マスタだけの一覧。**エージェントループ経路はこちらだけを同梱する**
 * (呼称は516件・約4,900トークンあり、毎ターン再送するには重すぎるので
 * `search_appellation` に置き換える。品種は84件・約560トークンと軽く、
 * 閉じた語彙なので同梱したほうが往復が減る)。
 */
function buildKnownGrapesSection(): string {
	const grapeNames = GRAPE_VARIETIES.map((v) => v.nameLocal);
	return [
		"## 既知の品種リスト(該当があればこの表記を使う)",
		grapeNames.join(" / "),
	].join("\n");
}

/**
 * モデルへの指示文。出力形式は guided_json が強制するため、内容の規範だけ書く。
 * 末尾にマスタ名の一覧を同梱する(読み取った綴りをマスタ表記へ正規化させる。
 * ラベルに無い項目を一覧から創作しないよう、読み取れた場合のみのルールは維持)。
 * マスタは静的データなのでモジュール初期化時に一度だけ組み立てる。
 */
export const LABEL_PROMPT = [
	"これはワインのボトル/エチケット(ラベル)の写真です。写真に写っている情報を読み取り、JSONで出力してください。",
	"- 写真から読み取れない項目は null にする。推測で創作しない。",
	"- vintage は西暦の整数(例: 2020)。",
	"- appellation はラベル記載の原産地呼称(AOC/AOP/DOC/DOCG など)を原語のまま。下の既知リストに該当があればその表記を一字一句そのまま使う。",
	"- grape_varieties はラベルに明記されている場合のみ。下の既知リストに該当があればその表記を使う。",
	"",
	buildKnownListsSection(),
].join("\n");

/**
 * 裏取りの規範。**どの経路でも同じことを求める**ので、経路ごとに書き分けない
 * (書き分けると「片方だけ規範が古い」状態が生まれる)。
 */
const LABEL_RESEARCH_RULES = [
	"   - 生産者名・ワイン名の綴りを正式表記に正す(写真の読み取り誤りを修正する)。",
	"   - 原産地呼称はラベルに明記されていなくても、このワインの正式なAOC/AOP/DOC/DOCG等を特定する。",
	"   - 品種はラベルに無記載でも、生産者情報・ワインデータベースで確認できたセパージュを列挙する(推測は不可。検索で確認できた場合のみ)。",
	"   - ヴィンテージは写真から読めた値を最優先する。写真から読めない場合は null にする(検索結果から創作しない)。",
];

/**
 * 出力フィールドの定義。**全経路で共有する**(Workers AI 経路の `LABEL_JSON_SCHEMA` と
 * 同じキーで、応答パースを `parseLabelResponse` に一本化するため)。
 */
const LABEL_OUTPUT_FIELD_RULES = [
	'   - "wine_name": キュヴェ名等を含む正式なワイン名(原語)。無ければ null',
	'   - "producer": 生産者/ドメーヌ/シャトー名(原語の正式表記)。無ければ null',
	'   - "vintage": 西暦の整数(例: 2020)。不明なら null',
	'   - "appellation": 正式な原産地呼称(原語)。不明なら null',
	'   - "region": 地域名(例: Bourgogne, Bordeaux, Toscana)。不明なら null',
	'   - "country": 生産国(例: France, Italy)。不明なら null',
	'   - "grape_varieties": 品種名(原語)の文字列配列。確認できなければ空配列',
	'   - "sources": 上記7フィールドそれぞれの根拠。キーはフィールド名と同じで、値は',
	'     { "origin": "photo" | "web" | "photo_and_web" | "unknown", "url": 文字列 or null }。',
	'     - "photo": 写真から読み取ってそのまま採用した',
	'     - "web": 写真には無く、検索で確認して補った',
	'     - "photo_and_web": 写真から読み取った値を検索で裏取り・修正した',
	'     - "unknown": 特定できず null / 空配列にした',
	'     "url" は origin が "web" / "photo_and_web" のとき、実際に参照したページのURLを1つ入れる。',
	"     それ以外は null。**URLを創作しない**(実際に開いていないURLを書かない)。",
];

/**
 * コメント(#471)の出力規範。**裏取りをする経路だけが使う**(Workers AI 経路は
 * このフィールド自体を持たない)。
 *
 * 引き写しを避けさせるのは著作権への配慮。テイスティングコメントの表現そのものは
 * 書き手の著作物になりうるため、「複数の評価に共通する特徴を自分の言葉で1〜3文に
 * まとめる」形に寄せる(producer-info.ts の解説と同じ方針)。
 */
const LABEL_COMMENT_FIELD_RULES = [
	'   - "tasting_comment": このワインの香り・味わいについての日本語のコメント(1〜3文)。',
	"     **web検索で見つかった評価・テイスティングコメント・販売ページの説明に現れる表現を踏まえて**書く。",
	"     複数の評価に共通する特徴(果実味・酸・タンニン・熟成香など)を自分の言葉でまとめること。",
	"     特定のページの文章をそのまま引き写さない。検索で何も見つからなければ null(推測で書かない)。",
	'   - "producer_comment": 生産者についての日本語のコメント(1〜2文)。所在地・歴史・造りの特徴など。',
	"     確認できなければ null。",
];

/** 写真の枚数と性質の説明。全経路で共通の前置き。 */
const LABEL_PHOTO_INTRO =
	"これはワインのボトル/エチケット(ラベル)の写真です(同一ボトルの表・裏ラベルなど複数枚のことがあります)。";

/**
 * 高精度経路(LLM + web検索)への指示文。読み取り→web検索での裏取り→JSON出力の
 * 手順を規定する。**Claude経路(label-web-research.ts)が使う**。
 *
 * GPT経路はエージェントループ化(#455 以降)に伴い `buildAgentLabelPrompt` を使うが、
 * 裏取りの規範と出力フィールドの定義はここと共有している(SSOT)。違うのは
 * 「1回で出し切る」か「ツールを使って収束させる」かという進め方だけ。
 */
export function buildWebLabelPrompt(): string {
	return [
		LABEL_PHOTO_INTRO,
		"以下の手順でこのワインの情報を特定し、最後にJSONオブジェクトだけを出力してください。",
		"",
		"1. 全ての写真からワイン名・生産者・ヴィンテージ・原産地呼称・地域・品種を読み取る。",
		"2. web検索で裏取りする。生産者の公式サイト、Wine-Searcher・Vivino等のワインデータベース、輸入元の商品ページ、原産地呼称の公式情報を優先して参照する。",
		...LABEL_RESEARCH_RULES,
		"   - **香り・味わいの評価と生産者の紹介も併せて拾う**(コメントの材料。下の tasting_comment / producer_comment)。",
		"3. 出力するJSONのフィールド:",
		...LABEL_OUTPUT_FIELD_RULES,
		...LABEL_COMMENT_FIELD_RULES,
		"4. 検索しても確認できない項目は null にする。JSONの前後に説明文・コードフェンスを書かない。",
		"",
		buildKnownListsSection(),
	].join("\n");
}

/**
 * エージェントループ経路への指示文。**1回で出し切らせず、ツールで裏を取ってから
 * `submit_answer` で提出させる**。
 *
 * `buildWebLabelPrompt` との違いは進め方だけで、裏取りの規範(`LABEL_RESEARCH_RULES`)と
 * 出力フィールドの定義(`LABEL_OUTPUT_FIELD_RULES`)は共有している。
 *
 * **呼称の一覧を同梱しない**のがコスト面での要点。516件・約4,900トークンを毎ターン
 * 再送するとループの固定費がターン数倍で効くため、`search_appellation` で必要な数件だけ
 * 引かせる。品種は84件と小さく、閉じた語彙なので同梱を続ける(検索の往復を減らす)。
 */
export function buildAgentLabelPrompt(): string {
	return [
		LABEL_PHOTO_INTRO,
		"ツールを使って調べながら、このワインを特定してください。**推測で埋めず、裏を取ってから提出すること。**",
		"",
		"1. 全ての写真からワイン名・生産者・ヴィンテージ・原産地呼称・地域・品種を読み取る。",
		"   **文字が小さくて読めない場合は zoom_photo で拡大して読み直すこと。** ボトル全体が写った写真では",
		"   ラベルの文字は潰れて読めないのが普通で、拡大すれば読めることが多い。生産者名が読めないまま",
		"   web検索に頼ると、条件の合う別のワインを掴んでしまう。**読めないなら推測せず、まず拡大する。**",
		"   - **小さな説明文まで読むこと。** 大きく印字された生産者名は瓶の曲面や見切れで欠けやすいが、",
		"     裏ラベルの説明文(畑・土壌・歴史の紹介)や輸入元表示に正式名が現れることが多い。",
		"     大きな文字が欠けていても諦めず、本文を拡大して探す。",
		"2. web検索で裏取りする。生産者の公式サイト、Wine-Searcher・Vivino等のワインデータベース、輸入元の商品ページ、原産地呼称の公式情報を優先して参照する。",
		...LABEL_RESEARCH_RULES,
		"3. 呼称と生産者はこのアプリのマスタとも突き合わせる。",
		"   - search_appellation: 読み取った呼称の綴りが不確かなときに候補を引く。マスタに該当があれば、その正式表記を一字一句そのまま使う。",
		"   - get_appellation: 呼称の許可品種・生産者・格付けを引く。読み取った品種がその呼称で認められているかの確認に使う。",
		"   - lookup_producer: **生産者名から呼称を逆引きする**。ラベルの呼称が欠けている・読めないときの主要な手がかり。",
		"   - マスタは対応地域ぶんしか無いので、**引けなくても誤りとは限らない**。その場合はweb検索の結果を優先してよい。",
		"4. 確信が持てたら submit_answer で提出する。引数のフィールド:",
		...LABEL_OUTPUT_FIELD_RULES,
		...LABEL_COMMENT_FIELD_RULES,
		"5. submit_answer は検証を行う。問題が返ってきたら、指摘された点を調べ直して再度 submit_answer を呼ぶこと。",
		"   同じ答えをそのまま再提出しない。確認できない項目は null / 空配列にして提出してよい。",
		"",
		buildKnownGrapesSection(),
	].join("\n");
}

/**
 * data URI を media type と base64 データに分解する。**HTTP URL を弾く境界も兼ねる**:
 * 高精度経路はどちらのプロバイダも外部URLを取得できてしまうため、クライアントが
 * 送れるのは自前で検証済みの data URI だけ、という前提をここで強制する
 * (Claude は base64 に分解して渡し、GPT は data URI のまま渡すが、検証は共通)。
 */
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

/** Workers AI(マルチモーダル)に渡すメッセージのcontent要素。 */
interface LabelContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

export interface LabelAiMessage {
	role: "user";
	content: LabelContentPart[];
}

/**
 * 指示文 + エチケット画像(data URI)1枚の1メッセージを組み立てる。
 * 複数写真は ai-service 側で1枚ずつ解析し、抽出結果を mergeExtractions で束ねる
 * (総合判断は抽出結果のマージ側で行う。1枚ずつにすることで、ある写真の解析失敗が
 * 全体を巻き込まないようにする)。
 */
export function buildLabelMessages(imageDataUrl: string): LabelAiMessage[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: LABEL_PROMPT },
				{ type: "image_url", image_url: { url: imageDataUrl } },
			],
		},
	];
}

// guided_json は Llama 4 Scout では完全には強制されず、型が揺れた JSON(例: vintage が
// 文字列 "2019"、grape_varieties が配列でなく文字列 "Chardonnay")を返すことがある。
// 型不一致で丸ごと弾くと「解析失敗」になり写真1枚が無駄になるため、各フィールドを
// 寛容に受けて正規化する(想定外の値は .catch でその項目だけ握りつぶす)。

/** 文字列/数値どちらでも文字列に寄せる。null/undefined と想定外はそのまま null。 */
const textField = z
	.union([z.string(), z.number()])
	.transform((v) => String(v))
	.nullish()
	.catch(null);

/** 数値/数字文字列を整数に寄せる。数値化できなければ null。 */
const vintageField = z
	.union([z.number(), z.string()])
	.transform((v) => {
		const n = typeof v === "number" ? v : Number.parseInt(v, 10);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	})
	.nullish()
	.catch(null);

/** 配列(文字列/数値要素)または単一文字列を文字列配列に寄せる。想定外は空配列。 */
const grapesField = z
	.union([z.array(z.union([z.string(), z.number()])), z.string()])
	.transform((v) => (typeof v === "string" ? [v] : v.map((g) => String(g))))
	.nullish()
	.catch([]);

/**
 * モデル出力(JSON)の受け取り側スキーマの構成要素。**一括抽出
 * (wine-list-extraction.ts)が銘柄1件ぶんの形としてこれを展開する**ので、
 * 揺れの吸収ルールが経路ごとにドリフトしないよう z.object ではなく shape で公開する。
 */
export const labelExtractionShape = {
	wine_name: textField,
	producer: textField,
	vintage: vintageField,
	appellation: textField,
	region: textField,
	country: textField,
	grape_varieties: grapesField,
} as const;

/**
 * コメント(#471)の受け取り側スキーマ。**本体より寛容にする**——コメントは付随情報で、
 * 形が崩れていても抽出結果は正しいことがある(`sources` と同じ判断)。ここで throw すると
 * 「コメントが書けなかっただけ」の回まで推論失敗になり、機能を足したせいで可用性が下がる。
 */
export const labelCommentShape = {
	tasting_comment: textField,
	producer_comment: textField,
} as const;

/** モデル出力(JSON)の受け取り側スキーマ。型の揺れに寛容な正規化つき。 */
const labelResponseSchema = z.object({
	...labelExtractionShape,
	...labelCommentShape,
});

/** モデル出力を正規化した抽出結果。未読取は undefined。 */
export interface LabelExtraction {
	wineName?: string;
	producer?: string;
	vintage?: number;
	appellation?: string;
	region?: string;
	country?: string;
	grapeVarieties: string[];
	/**
	 * 香り・味わいのコメント(#471)。web検索で裏取りする経路だけが持つ
	 * (Workers AI 経路は常に undefined)。
	 */
	tastingComment?: string;
	/** 生産者についてのコメント(#471)。同上。 */
	producerComment?: string;
}

/** 空文字・"null"等のプレースホルダを undefined に落とす。 */
function cleanText(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (/^(null|none|unknown|不明)$/i.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * コメント(#471)の正規化。プレースホルダの除去は `cleanText` と共通で、加えて
 * 「検索で見つからなかった」ことを**文章で**返してきた回を落とす。
 *
 * モデルは null を返す代わりに「情報が見つかりませんでした」と書くことがあり、それを
 * そのまま保存すると、利用者のセラーに中身のないコメントが並ぶ(手で消す手間になる)。
 */
function cleanComment(value: string | null | undefined): string | undefined {
	const text = cleanText(value);
	if (!text) return undefined;
	if (
		/(見つかりません|情報がありません|該当なし|not found|no information)/i.test(
			text,
		)
	) {
		return undefined;
	}
	return text;
}

/**
 * モデルの生出力からJSONオブジェクトを取り出す。guided_json / structured outputs で
 * JSON が強制される想定だが、コードフェンスや前後の文が混ざるケースに備えて
 * 最初の { 〜 最後の } を取り出す。Workers AI は guided_json 時に response を
 * **パース済みオブジェクト**で返すことがあるため(文字列前提だと TypeError で解析が
 * 全滅する)、オブジェクトはそのまま返す。解釈できない場合は throw(呼び出し側で
 * クレジット返却の上エラー応答にする)。
 *
 * 一括抽出(wine-list-extraction.ts)も同じ取り出しをするので共有する。
 */
export function extractJsonPayload(raw: unknown): unknown {
	if (typeof raw === "string") {
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start === -1 || end <= start) {
			throw new Error("AIの応答にJSONが含まれていません");
		}
		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {
			throw new Error("AIの応答を解釈できませんでした");
		}
	}
	if (raw !== null && typeof raw === "object") return raw;
	throw new Error("AIの応答にJSONが含まれていません");
}

/** labelExtractionShape で検証済みの値を、アプリ側の表現(未読取は undefined)へ写す。 */
export function toLabelExtraction(d: {
	wine_name?: string | null;
	producer?: string | null;
	vintage?: number | null;
	appellation?: string | null;
	region?: string | null;
	country?: string | null;
	grape_varieties?: string[] | null;
	/** 高精度経路のみ(#471)。Workers AI 経路・一括抽出では未指定になる。 */
	tasting_comment?: string | null;
	producer_comment?: string | null;
}): LabelExtraction {
	return {
		wineName: cleanText(d.wine_name),
		producer: cleanText(d.producer),
		vintage: d.vintage ?? undefined,
		appellation: cleanText(d.appellation),
		region: cleanText(d.region),
		country: cleanText(d.country),
		grapeVarieties: (d.grape_varieties ?? [])
			.map((g) => g.trim())
			.filter((g) => g.length > 0),
		tastingComment: cleanComment(d.tasting_comment),
		producerComment: cleanComment(d.producer_comment),
	};
}

/** 1フィールドぶんの根拠(アプリ側の表現)。 */
interface LabelFieldSource {
	origin: LabelFieldOrigin;
	/** origin が web を含むときの参照元URL。 */
	url?: string;
}

/** フィールドごとの根拠。モデルが書かなかったフィールドは持たない。 */
export type LabelFieldSources = Partial<
	Record<LabelFieldKey, LabelFieldSource>
>;

/**
 * `sources` の受け取り側スキーマ。**抽出本体より更に寛容にする**: これは観測のための
 * 付随情報で、形が崩れていても解析結果は正しいことがある。ここで throw すると
 * 「根拠が書けなかっただけ」の回まで推論失敗として予約を返却することになり、
 * 観測を足したせいで機能の可用性が下がる。
 *
 * 値がオブジェクトでなく `"web"` のような裸の文字列で返ることもあるので、その形も
 * origin として受ける。
 */
const fieldSourceSchema = z
	.union([
		z.object({
			origin: z.union([z.string(), z.number()]).nullish().catch(null),
			url: z.union([z.string(), z.number()]).nullish().catch(null),
		}),
		z.string().transform((origin) => ({ origin, url: null })),
	])
	.nullish()
	.catch(null);

/** 想定外の origin は "unknown" に寄せる(列挙外の造語でログの集計を壊さない)。 */
function toFieldOrigin(value: unknown): LabelFieldOrigin {
	const text = String(value ?? "")
		.trim()
		.toLowerCase();
	return (
		LABEL_FIELD_ORIGINS.find((o) => o === text) ??
		// "photo+web" のような表記揺れも拾う(モデルは列挙を厳密には守らない)
		(text.includes("photo") && text.includes("web")
			? "photo_and_web"
			: text.includes("web")
				? "web"
				: text.includes("photo")
					? "photo"
					: "unknown")
	);
}

/**
 * モデルの生出力から `sources` を取り出す。**決して throw しない**(取れなければ
 * undefined)。高精度経路のみが出力するフィールドで、Workers AI 経路では常に
 * undefined になる。生の応答文字列と `extractJsonPayload` 済みのオブジェクトの
 * どちらを渡してもよい。
 */
export function parseLabelSources(raw: unknown): LabelFieldSources | undefined {
	let payload: unknown;
	try {
		payload = extractJsonPayload(raw);
	} catch {
		return undefined;
	}
	const sources = (payload as { sources?: unknown } | null)?.sources;
	if (!sources || typeof sources !== "object") return undefined;
	const out: LabelFieldSources = {};
	for (const key of LABEL_JSON_SCHEMA.required) {
		const parsed = fieldSourceSchema.safeParse(
			(sources as Record<string, unknown>)[key],
		);
		if (!parsed.success || parsed.data == null) continue;
		const url = cleanText(
			parsed.data.url == null ? undefined : String(parsed.data.url),
		);
		out[key] = {
			origin: toFieldOrigin(parsed.data.origin),
			...(url ? { url } : {}),
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** モデルの生出力を1本ぶんの抽出結果にパースする。解釈できない場合は throw。 */
export function parseLabelResponse(raw: unknown): LabelExtraction {
	const result = labelResponseSchema.safeParse(extractJsonPayload(raw));
	if (!result.success) {
		throw new Error("AIの応答の形式が不正です");
	}
	return toLabelExtraction(result.data);
}

/**
 * 複数写真の抽出結果を1本ぶんに束ねる(総合判断)。スカラ項目は最初に読み取れた
 * 写真の値を採用し(表示順=配列順。先頭=代表写真を優先)、品種は全写真の和集合を取る。
 * 例: 表ラベルから呼称・生産者・ヴィンテージ、裏ラベルから品種、を1本ぶんに統合する。
 */
export function mergeExtractions(
	extractions: LabelExtraction[],
): LabelExtraction {
	const merged: LabelExtraction = { grapeVarieties: [] };
	for (const e of extractions) {
		merged.wineName ??= e.wineName;
		merged.producer ??= e.producer;
		merged.vintage ??= e.vintage;
		merged.appellation ??= e.appellation;
		merged.region ??= e.region;
		merged.country ??= e.country;
		merged.tastingComment ??= e.tastingComment;
		merged.producerComment ??= e.producerComment;
		for (const g of e.grapeVarieties) {
			if (!merged.grapeVarieties.includes(g)) merged.grapeVarieties.push(g);
		}
	}
	return merged;
}

// マスタ照合用の正規化。実装は産地ピッカーの検索と共有するため
// lib/wine/text-normalize へ移した(既存の import 先はここのまま)。
export { normalizeLabelText };

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

/** 国マスタの表記(id/現地語/日本語/英語)に無い別名の対応表(正規化形)。 */
const COUNTRY_ALIASES: Record<string, string> = {
	francia: "france",
	italie: "italy",
	仏: "france",
	伊: "italy",
};

/** 国テキスト群から国マスタの id を解決する。 */
function matchCountryId(texts: string[]): string | undefined {
	for (const rawText of texts) {
		const text = normalizeLabelText(rawText);
		if (!text) continue;
		const aliased = COUNTRY_ALIASES[text] ?? text;
		for (const country of WINE_COUNTRIES) {
			const labels = [
				country.id,
				country.nameLocal,
				country.nameJa,
				country.countryNameEn,
			];
			if (labels.some((l) => normalizeLabelText(l) === aliased)) {
				return country.id;
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

/**
 * フォームへ流し込める形の自動入力候補。キーは drunkWineFields と揃える。
 * 産地(aopId / regionId / countryId)は「最も細かい1つだけ」の排他で、フォームの
 * 産地紐付けの不変条件と同じ形にして返す(AOPが解決できたら地域・国は返さない)。
 */
export interface LabelSuggestions {
	name?: string;
	producer?: string;
	vintage?: number;
	aopId?: string;
	/** AOPまで特定できなかった場合の、地域単位の紐付け候補。 */
	regionId?: string;
	/** 地域も特定できなかった場合の、国単位の紐付け候補。 */
	countryId?: string;
	grapeVarietyIds?: string[];
	/**
	 * 銘柄のコメント(#471)。香り・味わい(web検索の裏取り経路のみ)と生産者の説明を
	 * 畳んだもの。どちらも無ければ持たない。
	 */
	note?: string;
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

	// 産地は最も細かい1つに解決する: AOP → 地域 → 国。AOPが解決できたら地域・国は
	// 返さない(保存の排他と同じ形。地域はサーバ側でAOPから導出される)。
	const aopTexts = [extraction.appellation, extraction.wineName].filter(
		(t): t is string => !!t,
	);
	const aop = matchAop(aopTexts);
	if (aop && getRegion(aop.region)?.enabled) {
		suggestions.aopId = aop.id;
	} else {
		const regionTexts = [extraction.region, extraction.appellation].filter(
			(t): t is string => !!t,
		);
		const regionId = matchRegionId(regionTexts);
		if (regionId) {
			suggestions.regionId = regionId;
		} else {
			// 地域まで特定できなければ国単位で拾う(国マスタに無い国は未紐付けのまま)
			const countryId = matchCountryId(
				[extraction.country, extraction.region].filter((t): t is string => !!t),
			);
			if (countryId) suggestions.countryId = countryId;
		}
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

	// コメント(#471)。**生産者の説明はこのアプリの辞書を優先する**(出典を確認して
	// 書いたものなので、モデルがその場で書いた文より信頼できる)。辞書に無い生産者の
	// ときだけモデルのコメントを使う。香り・味わいは裏取り経路のモデル出力しか
	// 情報源が無いのでそのまま使う。
	const knownProducer = extraction.producer
		? findProducerInfoByName(extraction.producer)
		: undefined;
	const producerComment =
		knownProducer?.info.description ?? extraction.producerComment;
	const note = buildWineNote({
		...(extraction.tastingComment
			? { tasting: extraction.tastingComment }
			: {}),
		...(producerComment ? { producer: producerComment } : {}),
	});
	if (note) suggestions.note = note;

	return suggestions;
}

/**
 * `LABEL_PROMPT` の入力トークン推定。
 *
 * 予約見積そのものは `config.ts` の `estimateLabelReserveUsage` が
 * `AI_LABEL_PROMPT_TOKEN_ESTIMATE`(定数)を使って行う。このモジュールは AOP/品種の
 * 全マスタを推移的に読み込むため、解析前の必要クレジットを表示するクライアントから
 * 参照させたくないため。実長が定数を超えていないことは単体テストが検証する。
 */
export function estimateLabelPromptTokens(): number {
	return Math.ceil(LABEL_PROMPT.length / CHARS_PER_TOKEN_ESTIMATE);
}
